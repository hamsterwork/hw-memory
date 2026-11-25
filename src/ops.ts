import type { DB } from "./db.ts"
import {
  countDebt,
  countFacts,
  countReminders,
  factAgeLabel,
  listDebt,
  listPendingPrunes,
  listReminders,
  maintain,
  resolvePrune,
  type FactRow,
} from "./core.ts"
import { applySeed, changedSeedScopes, planSeed } from "./seed.ts"
import { applyDocs, listDocUpdates, planDocs, scanDrift } from "./doc-sync.ts"
import { collectChanges, exportChangelog, listCheckpoints } from "./changelog.ts"
import type { ChangelogSource, ChangelogSummary } from "./changelog.ts"
import { getChangelogSource, getChangelogSummary } from "./config.ts"

/** Open items carry their id and age: a stale item must look stale. */
function formatOpenItems(rows: FactRow[]): string {
  if (rows.length === 0) return "None."
  return rows
    .map(
      (f) =>
        `#${f.id} [${f.rank}/${f.kind}] ${f.content}${f.origin ? ` (src: ${f.origin})` : ""} — ${factAgeLabel(f)}`,
    )
    .join("\n")
}

export interface CommandArgs {
  positional: string[]
  flags: Record<string, string | boolean>
}

export function seedOperation(db: DB, root: string, args: CommandArgs): string {
  if (args.flags["--changed"]) {
    const changed = changedSeedScopes(db, root, args.flags["--force"] === true)
    if (changed.length === 0) return "No seeded files changed since last scan."
    return ["Changed seeded scopes:", ...changed.map((c) => `- ${c.path}: ${c.reason} (+${c.added} -${c.removed} ~${c.changed})`)].join("\n")
  }
  const target = args.positional[0]
  if (!target) return "Usage: /hw-seed <path> [--apply] [--changed]"
  const apply = args.flags["--apply"] === true
  const report = apply ? applySeed(db, root, target) : planSeed(db, root, target)
  const changes = report.changes
  const count = (status: string) => changes.filter((c) => c.status === status).length
  const lines = [
    `${apply ? "APPLIED" : "DRY-RUN"} seed ${report.path}: files=${report.files} skipped=${report.skipped} blocks=${report.blocks.length}`,
    `inserted=${count("inserted")} updated=${count("updated-content")} rebound=${count("rebound")} demoted=${count("demoted")} merged=${count("merged")} unchanged=${count("unchanged")}`,
  ]
  for (const err of report.errors) lines.push(`error: ${err}`)
  if (!apply && changes.length > 0) {
    lines.push("", "Preview:")
    for (const c of changes.slice(0, 20)) lines.push(`- [${c.block.kind}/${c.block.rank}] ${c.status}: ${c.block.content}`)
  }
  if (!apply && changes.length > 0) lines.push("", "Run /hw-seed <path> --apply to commit.")
  return lines.join("\n")
}

export function docsOperation(db: DB, root: string, args: CommandArgs): string {
  const apply = args.flags["--apply"] === true
  const ids = typeof args.flags["--id"] === "string" ? [Number(args.flags["--id"])].filter(Number.isFinite) : undefined
  const report = apply ? applyDocs(db, root, ids) : planDocs(db, root)
  const lines = [
    `${apply ? "APPLIED" : "DRY-RUN"} docs: proposals=${report.proposals.length} writes=${report.writes.length} removals=${report.removals.length}`,
  ]
  if (report.drift.length > 0) {
    lines.push("", "Drifted seeded files:")
    for (const d of report.drift) {
      lines.push(`- ${d.path}: +${d.added} -${d.removed} ~${d.changed}${d.agentAttributed ? " (agent edit)" : ""}`)
    }
  }
  if (report.proposals.length > 0) {
    lines.push("", "Pending doc updates:")
    for (const p of report.proposals) lines.push(`- #${p.id} ${p.file}: ${p.content}`)
  }
  if (report.writes.length > 0) {
    lines.push("", "Writes:")
    for (const w of report.writes) lines.push(`- ${w.file}: ${w.added} line(s)`)
  }
  if (report.removals.length > 0) {
    lines.push("", "Removals:")
    for (const r of report.removals) lines.push(`- ${r.file}: ${r.content}`)
  }
  if (!apply) lines.push("", "Run /hw-docs --apply to write approved updates.")
  return lines.join("\n")
}

export function changesOperation(
  db: DB,
  root: string,
  args: CommandArgs,
  uncommitted: string[] = [],
): { text: string; aiPrompt?: string } {
  const version = args.positional[0]
  const source = (typeof args.flags["--source"] === "string" ? args.flags["--source"] : getChangelogSource(db)) as ChangelogSource
  const summary = (args.flags["--ai"] === true
    ? "ai"
    : args.flags["--deterministic"] === true
      ? "deterministic"
      : getChangelogSummary(db)) as ChangelogSummary
  const save = args.flags["--no-save"] !== true
  const report = collectChanges(db, root, version, { source, summary, save, uncommitted })
  const lines = [`# Changes since ${report.anchor.label} (${report.source})`, "", report.text]
  if (typeof args.flags["--source"] !== "string") lines.push("", `Source: ${report.source} (override with --source git|journal).`)
  if (report.savedId) lines.push(`Saved as changelog #${report.savedId}.`)
  if (args.flags["--export"] === true) lines.push(`Exported to ${exportChangelog(db, root)}.`)
  const checkpoints = listCheckpoints(db)
  if (checkpoints.length > 0) lines.push("", `Checkpoints: ${checkpoints.map((c) => c.label).join(", ")}`)
  if (summary === "ai") {
    return {
      text: lines.join("\n"),
      aiPrompt: `Rewrite this change list as a concise human-readable release note. Keep every version/feature name and do not invent details.\n\n${report.text}`,
    }
  }
  return { text: lines.join("\n") }
}

export function dashboardOperation(db: DB, root: string, args: CommandArgs): string {
  maintain(db)
  const debts = listDebt(db).slice(0, 10)
  const reminders = listReminders(db).slice(0, 10)
  const prunes = listPendingPrunes(db)
  const proposals = listDocUpdates(db).filter((p) => p.reason)
  const lines = [
    `## hw-memory dashboard (${countFacts(db)} facts)`,
    "",
    `### Top debts (${debts.length}/${countDebt(db)} open)`,
    formatOpenItems(debts),
    "",
    `### Top reminders (${reminders.length}/${countReminders(db)} open)`,
    formatOpenItems(reminders),
  ]
  if (prunes.length > 0) {
    lines.push("", "### Proposed medium-rank prunes (require approval)")
    for (const p of prunes) lines.push(`- #${p.fact_id} [${p.rank}/${p.kind}] ${p.content} (w=${p.weight.toFixed(3)})`)
    lines.push("Run /hw-dashboard --prune to approve all.")
  }
  if (proposals.length > 0) {
    lines.push("", `### Pending doc updates (${proposals.length}) — run /hw-docs to review`)
  }
  if (args.flags["--prune"] === true) {
    let approved = 0
    for (const p of prunes) if (resolvePrune(db, p.fact_id, true)) approved++
    lines.push("", `Approved ${approved} prune proposal(s).`)
  }
  const drift = scanDrift(db, root, { force: args.flags["--force"] === true })
  if (drift.length > 0) {
    lines.push("", "### Drifted seeded files")
    for (const d of drift) lines.push(`- ${d.path}: +${d.added} -${d.removed} ~${d.changed}`)
  }
  return lines.join("\n")
}

export function debtsOperation(db: DB): string {
  const rows = listDebt(db)
  return rows.length === 0 ? "No open debt." : formatOpenItems(rows)
}

export function remindersOperation(db: DB): string {
  const rows = listReminders(db)
  return rows.length === 0 ? "No reminders." : formatOpenItems(rows)
}
