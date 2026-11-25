import { join } from "node:path"
import type * as OpenCode from "@opencode/plugin"
import type { ToolEditor } from "@opencode/plugin/promise/tool"
import { z } from "zod"
import type { DB } from "./db.ts"
import { openDBFile } from "./db.ts"
import {
  addFact,
  countOpenItems,
  factAgeLabel,
  forgetFact,
  getFact,
  initSchema,
  listDebt,
  listReminders,
  listStaleOpenItems,
  maintain,
  resolveDebt,
  resolveFact,
  searchFacts,
  statsFacts,
  verifyFact,
  wakeUpPack,
  type FactRow,
  type Kind,
  type Rank,
} from "./core.ts"
import { queueDocUpdate, noteToolFileChange, scanDrift } from "./doc-sync.ts"
import { registerCommands } from "./commands.ts"
import {
  DEFAULT_CAP_ROWS,
  getCapRows,
  getChangelogSource,
  getChangelogSummary,
  isManagedKind,
  listTargets,
  setCapRows,
  setChangelogSource,
  setChangelogSummary,
  setTarget,
} from "./config.ts"
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

/** Open items are listed with their age so staleness is visible to the model too. */
function formatOpenRows(rows: FactRow[]): string {
  return rows
    .map((f) => `#${f.id} [${f.rank}] ${f.content}${f.origin ? ` (src: ${f.origin})` : ""} — ${factAgeLabel(f)}`)
    .join("\n")
}

function makeTools(root: string, db: DB) {
  const memoryAdd = defineTextTool({
    description:
      "Store a durable project fact into hw-memory. One fact per call. Managed kinds (decision/gotcha/debt) are also written to their managed markdown file when that entity is enabled. Use for: pinned decisions, resolved pitfalls, debt (code, process, data or research), project constraints.",
    name: "hw_memory_add",
    schema: z.object({
      content: z.string().describe("One dense fact, single sentence or two. Language-agnostic."),
      keywords: z.string().optional().describe("3-6 comma-separated terms that boost keyword search."),
      kind: z
        .enum(["decision", "gotcha", "debt", "changelog", "reminder", "error", "dependency", "fact"])
        .optional()
        .describe("Fact category. reminder stores plans, open questions and refactor notes; changelog stores release notes."),
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
        if (queueDocUpdate(db, { id: res.id, kind: res.kind, content: args.content, origin: null })) {
          note = " Doc update proposed — run /hw-docs to review."
        }
      }
      const openNote =
        res.kind === "debt"
          ? " ⚠ Technical debt recorded — tell the user about it before finishing the task."
          : res.kind === "reminder"
            ? " Open item recorded — verify or resolve it before finishing the task."
            : ""
      return `${res.status === "inserted" ? "Stored" : "Updated (duplicate)"} #${res.id} [${res.rank}/${res.kind}]${note}${openNote}`
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
        `cap: ${getCapRows(db)} (default ${DEFAULT_CAP_ROWS})`,
        `db: ${join(root, ".opencode", "hw-memory.db")}`,
        `files: ${listTargets(db).map((t) => `${t.kind}=${t.enabled ? t.path : "off"}`).join("; ")}`,
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

  const memoryDebt = defineTextTool({
    description:
      "Debt is a knowingly accepted cost that grows while it stays open — code, process, data or research, not only bugs. action=list (default) lists open debt with its age; action=verify with id records that you checked it and it is still open (weight and decay clock unchanged); action=resolve with id marks it done (its exact managed-doc line, if any, is removed on /hw-docs --apply). Always tell the user about new debt before finishing a task.",
    name: "hw_memory_debt",
    schema: z.object({
      action: z.enum(["list", "verify", "resolve"]).optional().describe("list (default), verify or resolve."),
      id: z.number().optional().describe("Debt id for verify/resolve."),
    }),
    async run(args) {
      if (args.action === "verify") {
        if (args.id == null) return "Provide the debt id to verify."
        const fact = verifyFact(db, args.id)
        if (!fact || fact.kind !== "debt") return `#${args.id} is not an open debt item.`
        return `Verified debt #${args.id} (still open, checked today). Weight and decay clock unchanged.`
      }
      if (args.action === "resolve") {
        if (args.id == null) return "Provide the debt id to resolve."
        const fact = resolveDebt(db, args.id)
        if (!fact) return `#${args.id} is not an open debt item.`
        return `Resolved debt #${args.id}. Its managed-doc line, if any, is removed on /hw-docs --apply.`
      }
      const rows = listDebt(db)
      if (rows.length === 0) return "No open debt."
      return formatOpenRows(rows)
    },
  })

  const memoryReminder = defineTextTool({
    description:
      "Reminders are work that only needs doing, with no compounding cost: plans, open questions and follow-ups. action=list (default) lists open reminders with their age; action=verify with id records that you checked it and it is still open (weight and decay clock unchanged); action=resolve with id marks it done (it leaves the lists; its managed-doc line, if any, is removed on /hw-docs --apply). Dispose of reminders a task touches before finishing it.",
    name: "hw_memory_reminder",
    schema: z.object({
      action: z.enum(["list", "verify", "resolve"]).optional().describe("list (default), verify or resolve."),
      id: z.number().optional().describe("Reminder id for verify/resolve."),
    }),
    async run(args) {
      if (args.action === "verify") {
        if (args.id == null) return "Provide the reminder id to verify."
        const fact = verifyFact(db, args.id)
        if (!fact || fact.kind !== "reminder") return `#${args.id} is not an open reminder.`
        return `Verified reminder #${args.id} (still open, checked today). Weight and decay clock unchanged.`
      }
      if (args.action === "resolve") {
        if (args.id == null) return "Provide the reminder id to resolve."
        const fact = resolveFact(db, args.id)
        if (!fact || fact.kind !== "reminder") return `#${args.id} is not an open reminder.`
        return `Resolved reminder #${args.id}. Its managed-doc line, if any, is removed on /hw-docs --apply.`
      }
      const rows = listReminders(db)
      if (rows.length === 0) return "No open reminders."
      return formatOpenRows(rows)
    },
  })

  const memoryConfig = defineTextTool({
    description:
      "Get or set hw-memory configuration for this project. Managed docs: decision, gotcha, debt, reminder and changelog can each be enabled/disabled; each writes to docs/hw-memory/ only after /hw-docs --apply. Capacity: cap_rows limits how many facts the DB keeps (default 500); debt, reminders and changelog are never evicted. Changelog: changelog_source (auto|git|journal) and changelog_summary (deterministic|ai). Lowering cap_rows enforces it immediately.",
    name: "hw_memory_config",
    schema: z.object({
      entity: z
        .enum(["decision", "gotcha", "debt", "reminder", "changelog"])
        .optional()
        .describe("Entity to configure; omit to list all."),
      enabled: z.boolean().optional().describe("Enable or disable write-back for the entity."),
      cap_rows: z
        .number()
        .int()
        .optional()
        .describe("Max facts kept in this project's DB (50..100000); default 500. Lowering enforces it immediately."),
      changelog_source: z
        .enum(["auto", "git", "journal"])
        .optional()
        .describe("Changelog source: auto (git when available), git or journal."),
      changelog_summary: z
        .enum(["deterministic", "ai"])
        .optional()
        .describe("Changelog summary style: deterministic bullets or AI opt-in."),
    }),
    async run(args) {
      if (args.cap_rows !== undefined) {
        const cap = setCapRows(db, args.cap_rows)
        const report = maintain(db, true)
        const evicted = report.capped > 0 ? ` (evicted ${report.capped} over-cap facts)` : ""
        return `cap_rows: ${cap}${evicted}`
      }
      if (args.changelog_source !== undefined) return `changelog.source: ${setChangelogSource(db, args.changelog_source)}`
      if (args.changelog_summary !== undefined) return `changelog.summary: ${setChangelogSummary(db, args.changelog_summary)}`
      if (!args.entity) {
        return [
          ...listTargets(db).map((t) => `${t.kind}: ${t.enabled ? "enabled" : "disabled"} -> ${t.path}`),
          `cap_rows: ${getCapRows(db)} (default ${DEFAULT_CAP_ROWS})`,
          `changelog.source: ${getChangelogSource(db)}`,
          `changelog.summary: ${getChangelogSummary(db)}`,
        ].join("\n")
      }
      const t = setTarget(db, args.entity, { enabled: args.enabled })
      return `${t.kind}: ${t.enabled ? "enabled" : "disabled"} -> ${t.path}`
    },
  })

  return [memoryAdd, memorySearch, memoryStats, memoryForget, memoryDebt, memoryReminder, memoryConfig]
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

/**
 * A completion phrase ends the task. ASCII words need real boundaries — `\b` both
 * matches inside "undone" and never matches Cyrillic, so the two scripts differ.
 */
const COMPLETION_ASCII = /(?<![a-z])(task finished|finished the task|task complete|task done|done)(?![a-z])/i
const COMPLETION_CYRILLIC = /(готово|завершено|выполнено|сделано)/i

export function isCompletionPhrase(text: string): boolean {
  return COMPLETION_ASCII.test(text) || COMPLETION_CYRILLIC.test(text)
}

/** Repeat window per item: an unaddressed nudge is not repeated within a day. */
const NUDGE_REPEAT_MS = 24 * 60 * 60 * 1000
/** Background pass: without a completion phrase, stale items still surface this often. */
const NUDGE_BACKGROUND_MS = 6 * 60 * 60 * 1000
/** Background nudges only include items unchecked for at least this long. */
const NUDGE_STALE_DAYS = 7
const NUDGE_LIMIT = 5

export const HwMemoryPlugin: OpenCode.Plugin.Plugin = {
  id: "hw-memory",

  async setup(ctx) {
    // V2 equivalent of the V1 `worktree || directory` root: the DB stays per location.
    const root = ctx.location.directory
    const db = await openDBFile(join(root, ".opencode", "hw-memory.db"))
    initSchema(db)
    const tracker = new SessionTracker()
    const controller = new AbortController()
    const forceScan = new Set<string>()
    const taskText = new Map<string, string>()
    const nudgedAt = new Map<string, number>()
    let lastScan = 0
    let lastNudge = Date.now()

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
      queueDocUpdate(db, { id, kind: "gotcha", content: fact.content, origin: fact.origin }, undefined, undefined, "error promoted to gotcha")
    }

    /** `task` is the last user prompt, so the pack can surface only relevant open items. */
    const pack = (sessionID?: string) => {
      maintain(db)
      return wakeUpPack(db, 2500, sessionID ? (taskText.get(sessionID) ?? "") : "")
    }

    const forgetSession = (sessionID: string) => {
      tracker.clear(sessionID)
      taskText.delete(sessionID)
      for (const key of nudgedAt.keys()) if (key.startsWith(`${sessionID}:`)) nudgedAt.delete(key)
    }

    // The DB is open and the schema is in place before the synchronous transform runs.
    await ctx.tool.transform((editor) => registerTools(editor, root, db))
    await registerCommands(ctx, db, root)

    await ctx.session.hook("prompt", (event) => {
      try {
        const text = String(event?.prompt?.text ?? "")
        const sessionID = String(event?.sessionID ?? "")
        if (!sessionID) return
        if (isCompletionPhrase(text)) forceScan.add(sessionID)
        // Keep the latest task so the next turn's pack can surface related open items.
        if (text.trim()) taskText.set(sessionID, text)
      } catch {
        // A prompt hook must never break admission.
      }
    })

    await ctx.session.hook("context", (event) => {
      try {
        event.system.push({ type: "text", text: pack(event.sessionID) })
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
        if (event.status !== "completed") return
        const fileTools = ["write", "edit", "patch", "apply_patch", "multitool"]
        if (fileTools.includes(event.tool)) {
          const input = event.input as Record<string, unknown> | undefined
          const pathValue = input?.path ?? input?.file ?? input?.filePath ?? input?.filename
          if (typeof pathValue === "string" && pathValue.length > 0) {
            noteToolFileChange(db, event.sessionID, pathValue, `${event.tool}: ${pathValue}`)
          }
        }
        if (event.tool !== "bash") return
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

    /**
     * Bounded, idempotent finish-time nudge. Rather than dumping every open item,
     * it names at most five that were not checked recently, gives their ids and
     * ages, and states what to do. Each item is repeated at most once a day.
     */
    const nudgeOpenItems = async (sessionID: string, forced: boolean) => {
      const now = Date.now()
      if (!forced && now - lastNudge < NUDGE_BACKGROUND_MS) return
      const candidates = listStaleOpenItems(db, { staleDays: forced ? 0 : NUDGE_STALE_DAYS, limit: 30 })
      const due = candidates
        .filter((f) => {
          const at = nudgedAt.get(`${sessionID}:${f.id}`)
          return at === undefined || now - at >= NUDGE_REPEAT_MS
        })
        .slice(0, NUDGE_LIMIT)
      if (due.length === 0) return
      lastNudge = now
      for (const f of due) nudgedAt.set(`${sessionID}:${f.id}`, now)
      const open = countOpenItems(db)
      const lines = [
        `## hw-memory: ${due.length} open item(s) need a decision${forced ? "" : " (stale check)"}`,
        "Tell the user, then dispose of each: `hw_memory_debt` / `hw_memory_reminder` with `action: verify` (still open) or `action: resolve` (done).",
        ...due.map((f) => `- #${f.id} [${f.rank}/${f.kind}] ${f.content} — ${factAgeLabel(f)}`),
      ]
      if (open > due.length) lines.push(`Full lists: /hw-debts and /hw-reminders (${open} open items).`)
      await ctx.session.synthetic({ sessionID, text: lines.join("\n") })
    }

    const onSessionIdle = async (sessionID: string) => {
      try {
        const messages = await ctx.session.context({ sessionID })
        await extractSessionDecisions(sessionID, messages, tracker, (id, candidate) => storeCandidate(id, candidate))
      } catch (e) {
        console.error("hw-memory assistant extraction failed:", e)
      }
      const forced = forceScan.delete(sessionID)
      try {
        if (forced || Date.now() - lastScan >= 3_600_000) {
          lastScan = Date.now()
          const drift = scanDrift(db, root, { force: true })
          if (drift.length > 0) {
            const lines = drift.map(
              (d) => `- ${d.path}: +${d.added} -${d.removed} ~${d.changed}${d.agentAttributed ? " (agent edit)" : ""}`,
            )
            await ctx.session.synthetic({
              sessionID,
              text: ["## hw-memory: seeded files changed", ...lines, "", "Run /hw-seed <path> to review."].join("\n"),
            })
          }
        }
      } catch (e) {
        console.error("hw-memory drift scan failed:", e)
      }
      try {
        await nudgeOpenItems(sessionID, forced)
      } catch (e) {
        console.error("hw-memory open-item check failed:", e)
      }
    }

    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (event.type === "session.deleted") forgetSession(event.data.sessionID)
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
