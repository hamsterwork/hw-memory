import { join } from "node:path"
import type { Plugin, ToolDefinition } from "@opencode-ai/plugin"
import { z } from "zod"
import type { DB } from "./db.ts"
import { openDBFile } from "./db.ts"
import {
  addFact,
  forgetFact,
  getFact,
  initSchema,
  maintain,
  searchFacts,
  statsFacts,
  updateOrigin,
  wakeUpPack,
  type Kind,
  type Rank,
} from "./core.ts"
import { docsFooterLines, reSeedFromDocs, writeCrucialToDocs } from "./docs.ts"
import {
  commandSignature,
  extractFromAssistantText,
  extractFromBash,
  SessionTracker,
  type Candidate,
} from "./extract.ts"
import { migrateMemoryDir } from "./migrate.ts"

interface CustomTool<A extends z.ZodRawShape> {
  description: string
  args: A
  execute(args: z.infer<z.ZodObject<A>>): Promise<string>
}

function defineTool<A extends z.ZodRawShape>(t: CustomTool<A>): ToolDefinition {
  return t as unknown as ToolDefinition
}

function formatFacts(rows: { id: number; rank: string; kind: string; content: string; origin: string | null }[]): string {
  if (rows.length === 0) return "No memories found."
  return rows.map((f) => `#${f.id} [${f.rank}/${f.kind}] ${f.content}${f.origin ? ` (src: ${f.origin})` : ""}`).join("\n")
}

function makeTools(root: string, db: DB): Record<string, ToolDefinition> {
  const memoryAdd = defineTool({
    description:
      "Store a durable project fact into hw-memory. One fact per call. Crucial facts (kind decision/gotcha or rank critical/high) are also appended to docs/ markdown automatically. Use for: pinned decisions, resolved pitfalls, project constraints.",
    args: {
      content: z.string().describe("One dense fact, single sentence or two. Language-agnostic."),
      keywords: z.string().optional().describe("3-6 comma-separated terms that boost keyword search."),
      kind: z
        .enum(["decision", "gotcha", "error", "dependency", "fact", "changelog"])
        .optional()
        .describe("Fact category. decision and gotcha are written to docs/."),
      rank: z
        .enum(["critical", "high", "medium", "low"])
        .optional()
        .describe("critical: never fades. high: slow decay, never pruned. medium: default. low: fades fast."),
    },
    async execute(args) {
      const res = addFact(db, {
        content: args.content,
        keywords: args.keywords ? args.keywords.split(",").map((k) => k.trim()).filter(Boolean) : undefined,
        kind: args.kind as Kind | undefined,
        rank: args.rank as Rank | undefined,
        source: "agent",
      })
      let note = ""
      if (res.status === "inserted" && res.crucial) {
        const fact = getFact(db, res.id)
        const written = writeCrucialToDocs(root, {
          id: res.id,
          content: fact!.content,
          keywords: fact!.keywords ? fact!.keywords.split(",") : [],
          kind: res.kind,
          rank: res.rank,
        })
        if (written.written) {
          updateOrigin(db, res.id, written.origin)
          note = ` Also appended to ${written.file}.`
        }
      }
      return `${res.status === "inserted" ? "Stored" : "Updated (duplicate)"} #${res.id} [${res.rank}/${res.kind}]${note}`
    },
  })

  const memorySearch = defineTool({
    description: "Search persistent project memory by keywords. Recall before risky or uncertain work, and when a past decision or pitfall may exist.",
    args: {
      query: z.string().describe("Search query, natural language or keywords."),
      limit: z.number().optional().describe("Max results, default 5."),
    },
    async execute(args) {
      maintain(db)
      const hits = searchFacts(db, args.query, { limit: args.limit ?? 5 })
      return formatFacts(hits)
    },
  })

  const memoryStats = defineTool({
    description: "Show hw-memory statistics: fact counts by rank, kind and source.",
    args: {},
    async execute() {
      maintain(db, true)
      const stats = statsFacts(db)
      const lines = [
        `total: ${stats.total}`,
        `by rank: ${JSON.stringify(stats.byRank)}`,
        `by kind: ${JSON.stringify(stats.byKind)}`,
        `by source: ${JSON.stringify(stats.bySource)}`,
        `avg weight: ${stats.avgWeight.toFixed(3)}`,
        `db: ${join(root, ".opencode", "hw-memory.db")}`,
        `docs: ${docsFooterLines(root).join("; ") || "none"}`,
      ]
      return lines.join("\n")
    },
  })

  const memoryForget = defineTool({
    description: "Delete a memory by id (see hw_memory_search output). Does not touch docs/ markdown.",
    args: { id: z.number().describe("Memory id from hw_memory_search.") },
    async execute(args) {
      return forgetFact(db, args.id) ? `Deleted #${args.id}.` : `#${args.id} not found.`
    },
  })

  const memorySeed = defineTool({
    description:
      "Seed or re-sync memory from docs/ markdown. On an empty DB this is the first-time seed; afterwards it imports new facts, updates changed, demotes vanished, and reports crucial facts missing from docs. Direct user command only — never run on your own initiative. Default is a dry-run report; apply with apply=true.",
    args: { apply: z.boolean().optional().describe("Apply changes. Default false (dry-run report).") },
    async execute(args) {
      const report = reSeedFromDocs(db, root, args.apply ?? false)
      const lines = [
        `${report.apply ? "APPLIED" : "DRY-RUN"} re-seed: files=${report.files} docFacts=${report.docFacts}`,
        `inserted=${report.inserted} updatedContent=${report.updatedContent} rebound=${report.rebound} demoted=${report.demoted} unchanged=${report.unchanged}`,
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

  const memoryMigrate = defineTool({
    description:
      "Migrate legacy .memory/ folder into docs/ layout, then seed the DB. Direct user command only. Default dry-run; apply=true executes. Never deletes .memory/ — user removes it manually.",
    args: { apply: z.boolean().optional().describe("Apply migration. Default false (dry-run plan).") },
    async execute(args) {
      const report = migrateMemoryDir(db, root, args.apply ?? false)
      if (!report.memoryDirFound) return "No .memory/ folder found."
      const lines = [`${report.apply ? "APPLIED" : "DRY-RUN"} migration:`]
      for (const c of report.copied) lines.push(`- ${c.from} -> ${c.to}${c.merged ? " (merge into existing)" : ""}`)
      if (report.agentsUpdated) lines.push(`- append "## Documentation" section to AGENTS.md`)
      for (const r of report.reviewManually) lines.push(`- review manually: ${r}`)
      if (report.apply && report.seed) {
        lines.push("", `seed: files=${report.seed.files} inserted=${report.seed.inserted} updated=${report.seed.updated}`)
      }
      return lines.join("\n")
    },
  })

  return {
    hw_memory_add: memoryAdd,
    hw_memory_search: memorySearch,
    hw_memory_stats: memoryStats,
    hw_memory_forget: memoryForget,
    hw_memory_seed: memorySeed,
    hw_memory_migrate: memoryMigrate,
  }
}

export const HwMemoryPlugin: Plugin = async ({ directory, worktree, client }) => {
  const root = worktree || directory
  const db = await openDBFile(join(root, ".opencode", "hw-memory.db"))
  initSchema(db)
  const tracker = new SessionTracker()

  const storeCandidate = (sessionID: string, candidate: Candidate, origin?: string) => {
    const res = addFact(db, {
      content: candidate.content,
      keywords: candidate.keywords,
      kind: candidate.kind,
      rank: candidate.rank,
      source: "auto",
      origin,
    })
    return res
  }

  const promoteErrorToGotcha = (id: number) => {
    const fact = getFact(db, id)
    if (!fact || fact.kind !== "error") return
    db.prepare("UPDATE memories SET kind = 'gotcha', rank = 'high', weight = 1.0, last_verified_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id)
    const updated = getFact(db, id)
    const written = writeCrucialToDocs(root, {
      id,
      content: updated!.content,
      keywords: updated!.keywords ? updated!.keywords.split(",") : [],
      kind: "gotcha",
      rank: "high",
    })
    if (written.written) updateOrigin(db, id, written.origin)
  }

  return {
    "experimental.chat.system.transform": async (_input, output) => {
      try {
        maintain(db)
        output.system.push(wakeUpPack(db, docsFooterLines(root)))
      } catch (e) {
        console.error("hw-memory wake-up failed:", e)
      }
    },

    "tool.execute.after": async (input, output) => {
      try {
        if (input.tool !== "bash") return
        const cmd: string = input.args?.command ?? ""
        const text: string = typeof output.output === "string" ? output.output : ""
        const metadata = output.metadata as Record<string, unknown> | undefined
        const exit = typeof metadata?.exitCode === "number" ? metadata.exitCode : undefined
        if (!cmd || text.length < 20) return
        if (!tracker.shouldExtractBash(input.sessionID)) return
        maintain(db)
        const sig = commandSignature(cmd)
        if (exit === 0) {
          const promotion = tracker.noteSuccess(input.sessionID, sig)
          if (promotion) for (const id of promotion.errorIds) promoteErrorToGotcha(id)
        }
        for (const candidate of extractFromBash(cmd, text, exit)) {
          const res = storeCandidate(input.sessionID, candidate)
          if (candidate.kind === "error" && res.status === "inserted") {
            tracker.noteError(input.sessionID, sig, res.id)
          }
        }
      } catch (e) {
        console.error("hw-memory extraction failed:", e)
      }
    },

    event: async ({ event }) => {
      try {
        if (event.type === "session.deleted") {
          tracker.clear((event.properties as { info: { id: string } }).info.id)
          return
        }
        if (event.type !== "session.idle") return
        const sessionID = (event.properties as { sessionID: string }).sessionID
        const res: any = await client.session.messages({ path: { id: sessionID }, query: { directory } })
        const messages = res?.data ?? []
        for (const message of messages) {
          if (message.info?.role !== "assistant") continue
          for (const part of message.parts ?? []) {
            if (part.type !== "text" || part.synthetic) continue
            for (const candidate of extractFromAssistantText(part.text)) {
              if (!tracker.isNewSentence(sessionID, candidate.content)) continue
              storeCandidate(sessionID, candidate)
            }
          }
        }
      } catch (e) {
        console.error("hw-memory assistant extraction failed:", e)
      }
    },

    "experimental.session.compacting": async (_input, output) => {
      try {
        maintain(db)
        const top = (db
          .prepare("SELECT id, rank, kind, content, origin FROM memories ORDER BY weight DESC LIMIT 10")
          .all() as any[]) as { id: number; rank: string; kind: string; content: string; origin: string | null }[]
        output.context.push(
          ["## hw-memory: these project facts are already persisted — do not re-store them:", ...top.map((f) => `- [${f.rank}/${f.kind}] ${f.content}`)].join("\n"),
        )
      } catch (e) {
        console.error("hw-memory compaction context failed:", e)
      }
    },

    tool: makeTools(root, db),
  }
}

export default HwMemoryPlugin
