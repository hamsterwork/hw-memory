import { join } from "node:path"
import type * as OpenCode from "@opencode/plugin"
import type { ToolEditor } from "@opencode/plugin/promise/tool"
import { z } from "zod"
import type { DB } from "./db.ts"
import { openDBFile } from "./db.ts"
import {
  addFact,
  forgetFact,
  getFact,
  initSchema,
  listDebt,
  maintain,
  resolveDebt,
  searchFacts,
  statsFacts,
  updateOrigin,
  wakeUpPack,
  type Kind,
  type Rank,
} from "./core.ts"
import { docsFooterLines, removeEntityLine, reSeedFromDocs, syncEntityToFile } from "./docs.ts"
import { getTarget, isManagedKind, listTargets, setTarget } from "./config.ts"
import {
  commandSignature,
  extractFromAssistantText,
  extractFromBash,
  SessionTracker,
  type Candidate,
} from "./extract.ts"

/** A tool whose body returns plain text; V2 wraps that text into `{ content }`. */
interface TextTool<S extends z.ZodType> {
  name: string
  description: string
  schema: S
  run(input: z.output<S>): Promise<string>
}

/**
 * JSON Schema for a tool input. The zod object stays the single source of truth;
 * V2 takes a value schema (plain JSON Schema) rather than a zod raw shape.
 */
function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _dialect, ...rest } = z.toJSONSchema(schema, { io: "input" })
  return rest
}

function defineTextTool<S extends z.ZodType>(spec: TextTool<S>) {
  return {
    name: spec.name,
    description: spec.description,
    input: toJsonSchema(spec.schema),
    execute: async (input: unknown) => ({ content: await spec.run(spec.schema.parse(input)) }),
  }
}

function formatFacts(rows: { id: number; rank: string; kind: string; content: string; origin: string | null }[]): string {
  if (rows.length === 0) return "No memories found."
  return rows.map((f) => `#${f.id} [${f.rank}/${f.kind}] ${f.content}${f.origin ? ` (src: ${f.origin})` : ""}`).join("\n")
}

function makeTools(root: string, db: DB) {
  const memoryAdd = defineTextTool({
    description:
      "Store a durable project fact into hw-memory. One fact per call. Managed kinds (decision/gotcha/debt) are also written to their managed markdown file when that entity is enabled. Use for: pinned decisions, resolved pitfalls, technical debt, project constraints.",
    name: "hw_memory_add",
    schema: z.object({
      content: z.string().describe("One dense fact, single sentence or two. Language-agnostic."),
      keywords: z.string().optional().describe("3-6 comma-separated terms that boost keyword search."),
      kind: z
        .enum(["decision", "gotcha", "debt", "error", "dependency", "fact", "changelog"])
        .optional()
        .describe("Fact category. decision/gotcha/debt are also written to their managed file when enabled."),
      rank: z
        .enum(["critical", "high", "medium", "low"])
        .optional()
        .describe(
          "critical: never fades. high: slow decay, never pruned. medium: default. low: fades fast. Debt is clamped to medium..critical.",
        ),
    }),
    async run(args) {
      const res = addFact(db, {
        content: args.content,
        keywords: args.keywords ? args.keywords.split(",").map((k) => k.trim()).filter(Boolean) : undefined,
        kind: args.kind as Kind | undefined,
        rank: args.rank as Rank | undefined,
        source: "agent",
      })
      let note = ""
      if (res.status === "inserted" && isManagedKind(res.kind)) {
        const sync = syncEntityToFile(db, root, res.kind)
        if (sync.written > 0) note = ` Also written to ${sync.file}.`
      }
      const debtNote =
        res.kind === "debt" ? " ⚠ Technical debt recorded — tell the user about it before finishing the task." : ""
      return `${res.status === "inserted" ? "Stored" : "Updated (duplicate)"} #${res.id} [${res.rank}/${res.kind}]${note}${debtNote}`
    },
  })

  const memorySearch = defineTextTool({
    description:
      "Search persistent project memory by keywords. Recall before risky or uncertain work, and when a past decision or pitfall may exist.",
    name: "hw_memory_search",
    schema: z.object({
      query: z.string().describe("Search query, natural language or keywords."),
      limit: z.number().optional().describe("Max results, default 5."),
    }),
    async run(args) {
      maintain(db)
      const hits = searchFacts(db, args.query, { limit: args.limit ?? 5 })
      return formatFacts(hits)
    },
  })

  const memoryStats = defineTextTool({
    description: "Show hw-memory statistics: fact counts by rank, kind and source.",
    name: "hw_memory_stats",
    schema: z.object({}),
    async run() {
      maintain(db, true)
      const stats = statsFacts(db)
      const lines = [
        `total: ${stats.total}`,
        `by rank: ${JSON.stringify(stats.byRank)}`,
        `by kind: ${JSON.stringify(stats.byKind)}`,
        `by source: ${JSON.stringify(stats.bySource)}`,
        `open debt: ${stats.debt}`,
        `avg weight: ${stats.avgWeight.toFixed(3)}`,
        `db: ${join(root, ".opencode", "hw-memory.db")}`,
        `files: ${listTargets(db).map((t) => `${t.kind}=${t.enabled ? t.path : "off"}`).join("; ")}`,
        `docs: ${docsFooterLines(root, db).join("; ") || "none"}`,
      ]
      return lines.join("\n")
    },
  })

  const memoryForget = defineTextTool({
    description: "Delete a memory by id (see hw_memory_search output). Does not touch docs/ markdown.",
    name: "hw_memory_forget",
    schema: z.object({ id: z.number().describe("Memory id from hw_memory_search.") }),
    async run(args) {
      return forgetFact(db, args.id) ? `Deleted #${args.id}.` : `#${args.id} not found.`
    },
  })

  const memorySeed = defineTextTool({
    description:
      "Seed or re-sync memory from docs/ markdown. On an empty DB this is the first-time seed; afterwards it imports new facts, updates changed, demotes vanished, and reports crucial facts missing from docs. Direct user command only — never run on your own initiative. Default is a dry-run report; apply with apply=true.",
    name: "hw_memory_seed",
    schema: z.object({ apply: z.boolean().optional().describe("Apply changes. Default false (dry-run report).") }),
    async run(args) {
      const report = reSeedFromDocs(db, root, args.apply ?? false)
      const lines = [
        `${report.apply ? "APPLIED" : "DRY-RUN"} re-seed: files=${report.files} docFacts=${report.docFacts}`,
        `inserted=${report.inserted} updatedContent=${report.updatedContent} rebound=${report.rebound} demoted=${report.demoted} merged=${report.merged} unchanged=${report.unchanged}`,
      ]
      if (report.missingFromDocs.length > 0) {
        lines.push("", `Crucial facts present in memory but missing from docs (${report.missingFromDocs.length}):`)
        for (const m of report.missingFromDocs.slice(0, 20)) {
          lines.push(`- #${m.id} [${m.rank}/${m.kind}] ${m.content}`)
        }
      }
      return lines.join("\n")
    },
  })

  const memoryDebt = defineTextTool({
    description:
      "Technical debt found while working on other tasks. action=list (default) lists open debt; action=resolve with id removes it (and its line from the managed debt file when enabled). Always tell the user about new debt before finishing a task.",
    name: "hw_memory_debt",
    schema: z.object({
      action: z.enum(["list", "resolve"]).optional().describe("list (default) or resolve."),
      id: z.number().optional().describe("Debt id to resolve."),
    }),
    async run(args) {
      if (args.action === "resolve") {
        if (args.id == null) return "Provide the debt id to resolve."
        const fact = resolveDebt(db, args.id)
        if (!fact) return `#${args.id} is not an open debt item.`
        const target = getTarget(db, "debt")
        if (target.enabled) removeEntityLine(root, target.path, fact.content)
        return `Resolved and removed debt #${args.id}.`
      }
      const rows = listDebt(db)
      if (rows.length === 0) return "No open technical debt."
      return rows
        .map((f) => `#${f.id} [${f.rank}] ${f.content}${f.origin ? ` (src: ${f.origin})` : ""}`)
        .join("\n")
    },
  })

  const memoryConfig = defineTextTool({
    description:
      "Get or set hw-memory managed-file write-back. decision, gotcha and debt can each be enabled/disabled; each writes to its fixed file in docs/hw-memory/ (decisions.md, gotchas.md, debt.md). Disabled means facts live only in the DB.",
    name: "hw_memory_config",
    schema: z.object({
      entity: z.enum(["decision", "gotcha", "debt"]).optional().describe("Entity to configure; omit to list all."),
      enabled: z.boolean().optional().describe("Enable or disable write-back for the entity."),
    }),
    async run(args) {
      if (!args.entity) {
        return listTargets(db)
          .map((t) => `${t.kind}: ${t.enabled ? "enabled" : "disabled"} -> ${t.path}`)
          .join("\n")
      }
      const t = setTarget(db, args.entity, { enabled: args.enabled })
      return `${t.kind}: ${t.enabled ? "enabled" : "disabled"} -> ${t.path}`
    },
  })

  return [memoryAdd, memorySearch, memoryStats, memoryForget, memorySeed, memoryDebt, memoryConfig]
}

function registerTools(editor: ToolEditor, root: string, db: DB): void {
  for (const tool of makeTools(root, db)) editor.add(tool)
}

interface FlatMessage {
  type?: string
  content?: Array<{ type?: string; text?: string }>
}

/**
 * Store decisions stated in an assistant turn. V2 `session.context` returns flat
 * message records (`type: "assistant"`, `content[]`) instead of V1 `{ info, parts }`;
 * synthetic turns are their own message type, so only assistant text is read.
 */
export async function extractSessionDecisions(
  sessionID: string,
  messages: readonly unknown[],
  tracker: SessionTracker,
  store: (sessionID: string, candidate: Candidate) => void,
): Promise<void> {
  for (const message of messages) {
    const m = message as FlatMessage
    if (m.type !== "assistant") continue
    for (const part of m.content ?? []) {
      if (part.type !== "text" || typeof part.text !== "string") continue
      for (const candidate of extractFromAssistantText(part.text)) {
        if (!tracker.isNewSentence(sessionID, candidate.content)) continue
        store(sessionID, candidate)
      }
    }
  }
}

/** Tool result text: V2 results carry a string or an array of content parts. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .filter((p): p is { type: "text"; text: string } => p?.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n")
}

export const HwMemoryPlugin: OpenCode.Plugin.Plugin = {
  id: "hw-memory",

  async setup(ctx) {
    // V2 equivalent of the V1 `worktree || directory` root: the DB stays per location.
    const root = ctx.location.directory
    const db = await openDBFile(join(root, ".opencode", "hw-memory.db"))
    initSchema(db)
    const tracker = new SessionTracker()
    const controller = new AbortController()

    const storeCandidate = (sessionID: string, candidate: Candidate, origin?: string) => {
      addFact(db, {
        content: candidate.content,
        keywords: candidate.keywords,
        kind: candidate.kind,
        rank: candidate.rank,
        source: "auto",
        origin,
      })
    }

    const promoteErrorToGotcha = (id: number) => {
      const fact = getFact(db, id)
      if (!fact || fact.kind !== "error") return
      db.prepare("UPDATE memories SET kind = 'gotcha', rank = 'high', weight = 1.0, last_verified_at = ? WHERE id = ?")
        .run(new Date().toISOString(), id)
      const sync = syncEntityToFile(db, root, "gotcha")
      if (sync.written > 0 && sync.origin) updateOrigin(db, id, sync.origin)
    }

    const pack = () => {
      maintain(db)
      return wakeUpPack(db, docsFooterLines(root, db))
    }

    // The DB is open and the schema is in place before the synchronous transform runs.
    await ctx.tool.transform((editor) => registerTools(editor, root, db))

    await ctx.session.hook("context", (event) => {
      try {
        event.system.push({ type: "text", text: pack() })
      } catch (e) {
        console.error("hw-memory wake-up failed:", e)
      }
    })

    await ctx.session.hook("compaction", (event) => {
      try {
        maintain(db)
        const top = (db
          .prepare("SELECT id, rank, kind, content, origin FROM memories ORDER BY weight DESC LIMIT 10")
          .all() as any[]) as { id: number; rank: string; kind: string; content: string; origin: string | null }[]
        event.system.push({
          type: "text",
          text: [
            "## hw-memory: these project facts are already persisted — do not re-store them:",
            ...top.map((f) => `- [${f.rank}/${f.kind}] ${f.content}`),
          ].join("\n"),
        })
      } catch (e) {
        console.error("hw-memory compaction context failed:", e)
      }
    })

    await ctx.tool.hook("execute.after", (event) => {
      try {
        if (event.tool !== "bash") return
        if (event.status !== "completed") return
        const cmd = typeof (event.input as { command?: unknown } | undefined)?.command === "string"
          ? ((event.input as { command: string }).command)
          : ""
        const text = resultText(event.result.content)
        const exit = typeof event.result.metadata?.exitCode === "number" ? event.result.metadata.exitCode : undefined
        if (!cmd || text.length < 20) return
        if (!tracker.shouldExtractBash(event.sessionID)) return
        maintain(db)
        const sig = commandSignature(cmd)
        if (exit === 0) {
          const promotion = tracker.noteSuccess(event.sessionID, sig)
          if (promotion) for (const id of promotion.errorIds) promoteErrorToGotcha(id)
        }
        for (const candidate of extractFromBash(cmd, text, exit)) {
          const res = addFact(db, {
            content: candidate.content,
            keywords: candidate.keywords,
            kind: candidate.kind,
            rank: candidate.rank,
            source: "auto",
          })
          if (candidate.kind === "error" && res.status === "inserted") {
            tracker.noteError(event.sessionID, sig, res.id)
          }
        }
      } catch (e) {
        console.error("hw-memory extraction failed:", e)
      }
    })

    const onSessionIdle = async (sessionID: string) => {
      try {
        const messages = await ctx.session.context({ sessionID })
        await extractSessionDecisions(sessionID, messages, tracker, (id, candidate) => storeCandidate(id, candidate))
      } catch (e) {
        console.error("hw-memory assistant extraction failed:", e)
      }
    }

    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (event.type === "session.deleted") tracker.clear(event.data.sessionID)
          else if (event.type === "session.idle") await onSessionIdle(event.data.sessionID)
        }
      } catch (e) {
        if (!controller.signal.aborted) console.error("hw-memory event stream failed:", e)
      }
    })()

    return () => {
      controller.abort()
      db.close()
    }
  },
}

export default HwMemoryPlugin
