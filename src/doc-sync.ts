import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, dirname, isAbsolute, join } from "node:path"
import type { DB } from "./db.ts"
import type { FactRow, Kind, Rank } from "./core.ts"
import { getFact, listFactsByKind } from "./core.ts"
import { DEFAULT_TARGET_PATH, getTarget, isManagedKind, MANAGED_KINDS, type ManagedKind } from "./config.ts"
import { contentHash, nowISO, stripMarkdown, titleFrom } from "./util.ts"
import { isDir, isFile } from "./fs.ts"

export interface DocDrift {
  path: string
  added: number
  removed: number
  changed: number
  reason: string
  agentAttributed: boolean
}

export interface DocUpdateRow {
  id: number
  factId: number
  file: string
  heading: string
  content: string
  reason: string
}

export interface DocPlan {
  proposals: DocUpdateRow[]
  drift: DocDrift[]
  writes: { file: string; added: number }[]
  removals: { file: string; content: string }[]
}

const KIND_TITLE: Record<ManagedKind, string> = {
  decision: "Decision",
  gotcha: "Gotcha",
  debt: "Debt",
  reminder: "Reminder",
  changelog: "Changelog",
}

const FILE_TITLE: Record<string, string> = {
  [DEFAULT_TARGET_PATH.decision]: "Decisions",
  [DEFAULT_TARGET_PATH.gotcha]: "Gotchas",
  [DEFAULT_TARGET_PATH.debt]: "Debt",
  [DEFAULT_TARGET_PATH.reminder]: "Reminders",
  [DEFAULT_TARGET_PATH.changelog]: "Changelog",
}

function kindTitle(kind: string): string {
  return isManagedKind(kind) ? KIND_TITLE[kind] : titleFrom(kind)
}

function fileTitle(rel: string): string {
  if (FILE_TITLE[rel]) return FILE_TITLE[rel]
  return basename(rel)
    .replace(/\.md$/i, "")
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ") || "Notes"
}

function cleanContent(content: string): string {
  return stripMarkdown(content).replace(/\s+/g, " ").trim()
}

/** The single bullet format used by both the renderer and the safe writer. */
function renderBullet(content: string, kind?: Kind, rank?: Rank): string {
  const prefix = kind === "debt" ? `[${rank ?? "medium"}] ` : ""
  return `- ${prefix}${cleanContent(content)}`
}

function groupHeading(fact: FactRow): string {
  const keyword = fact.keywords
    .split(",")
    .map((k) => k.trim())
    .find(Boolean)
  if (!keyword) return kindTitle(fact.kind)
  return keyword[0].toUpperCase() + keyword.slice(1)
}

function resolvePath(root: string, rel: string): string {
  return isAbsolute(rel) ? rel : join(root, rel)
}

function kindFromFile(rel: string): Kind {
  for (const kind of MANAGED_KINDS) if (DEFAULT_TARGET_PATH[kind] === rel) return kind
  const base = basename(rel).toLowerCase()
  for (const kind of MANAGED_KINDS) if (base.includes(kind)) return kind
  return "fact"
}

/** Render the plugin-managed markdown files from the DB, with no internal metadata. */
export function renderDocs(db: DB): Record<string, string> {
  const out: Record<string, string> = {}
  for (const kind of MANAGED_KINDS) {
    const rel = DEFAULT_TARGET_PATH[kind]
    const lines = [`# ${fileTitle(rel)}`, ""]
    const facts = listFactsByKind(db, kind)
      .filter((f) => !f.obsolete_at)
      .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id)
    const groups = new Map<string, FactRow[]>()
    for (const fact of facts) {
      const heading = groupHeading(fact)
      if (!groups.has(heading)) groups.set(heading, [])
      groups.get(heading)!.push(fact)
    }
    for (const [heading, group] of groups) {
      lines.push(`## ${heading}`, "")
      for (const fact of group) lines.push(renderBullet(fact.content, fact.kind, fact.rank))
      lines.push("")
    }
    out[rel] = `${lines.join("\n").trimEnd()}\n`
  }
  return out
}

/** Queue one pending doc update; returns false for an existing queued duplicate. */
export function queueDocUpdate(
  db: DB,
  fact: { id: number; kind: Kind; content: string; origin: string | null },
  file?: string,
  heading?: string,
  reason?: string,
): boolean {
  const rel = file?.trim() || (isManagedKind(fact.kind) ? DEFAULT_TARGET_PATH[fact.kind] : "")
  if (!rel) return false
  if (isManagedKind(fact.kind) && !getTarget(db, fact.kind).enabled) return false
  const content = cleanContent(fact.content)
  const existing = db
    .prepare(
      `SELECT id FROM pending_doc_updates
       WHERE fact_id = ? AND file = ? AND content = ? AND status IN ('proposed','queued') LIMIT 1`,
    )
    .get(fact.id, rel, content)
  if (existing) return false
  db.prepare(
    `INSERT INTO pending_doc_updates (fact_id, file, heading, content, reason, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'proposed', ?)`,
  ).run(fact.id, rel, heading?.trim() || kindTitle(fact.kind), content, reason?.trim() || "new crucial fact", nowISO())
  return true
}

export function listDocUpdates(db: DB): DocUpdateRow[] {
  const rows = db
    .prepare(
      `SELECT id, fact_id, file, heading, content, reason FROM pending_doc_updates
       WHERE status IN ('proposed','queued') ORDER BY id`,
    )
    .all() as any[]
  return rows.map((r) => ({
    id: Number(r.id),
    factId: Number(r.fact_id),
    file: String(r.file),
    heading: String(r.heading ?? ""),
    content: String(r.content ?? ""),
    reason: String(r.reason ?? ""),
  }))
}

function parseLineHashes(raw: unknown): string[] {
  if (typeof raw !== "string" || raw.trim() === "") return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

/**
 * Longest-common-subsequence diff over line hashes. Within each edited block,
 * paired removals/insertions count as changed lines; the surplus counts as
 * pure removals or additions.
 */
function compareLineHashes(before: string[], after: string[]): { added: number; removed: number; changed: number } {
  const n = before.length
  const m = after.length
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] =
        before[i] === after[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }
  let added = 0
  let removed = 0
  let changed = 0
  let deleted = 0
  let inserted = 0
  const flush = (): void => {
    const pairs = Math.min(deleted, inserted)
    changed += pairs
    removed += deleted - pairs
    added += inserted - pairs
    deleted = 0
    inserted = 0
  }
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      flush()
      i++
      j++
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      deleted++
      i++
    } else {
      inserted++
      j++
    }
  }
  deleted += n - i
  inserted += m - j
  flush()
  return { added, removed, changed }
}

interface ScopedFile {
  abs: string
  rel: string
}

function listFiles(abs: string): ScopedFile[] {
  const out: ScopedFile[] = []
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".opencode" || entry.name === "node_modules") continue
      const child = join(dir, entry.name)
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(child, rel)
      else if (entry.isFile()) out.push({ abs: child, rel })
    }
  }
  walk(abs, "")
  return out
}

function folderHash(files: ScopedFile[]): string {
  return contentHash(
    files
      .map((f) => `${f.rel}\0${contentHash(readFileSync(f.abs, "utf8"))}`)
      .sort()
      .join("\n"),
  )
}

function normalizedRef(root: string, ref: string): string {
  const rootNorm = root.replaceAll("\\", "/")
  let value = ref.replaceAll("\\", "/")
  if (value.startsWith(`${rootNorm}/`)) value = value.slice(rootNorm.length + 1)
  return value.replace(/^\.\//, "")
}

/** Report every drifted seed scope; `force` is advisory only and never filters results. */
export function scanDrift(db: DB, root: string, opts?: { force?: boolean }): DocDrift[] {
  void opts?.force
  const scopes = db.prepare("SELECT * FROM seed_scopes ORDER BY path").all() as any[]
  const events = db.prepare("SELECT ref, created_at FROM change_events WHERE source = 'agent-tool'").all() as {
    ref: string | null
    created_at: string
  }[]
  const out: DocDrift[] = []
  for (const scope of scopes) {
    const path = String(scope.path)
    const abs = resolvePath(root, path)
    const seededAt = scope.last_seeded_at ? String(scope.last_seeded_at) : ""
    const lastSeenHash = String(scope.last_seen_hash ?? "")
    const storedLines = parseLineHashes(scope.line_hashes)
    const isFolder = isDir(abs)
    let added = 0
    let removed = 0
    let changed = 0
    let reason = ""

    if (isFolder) {
      const files = listFiles(abs)
      const hash = folderHash(files)
      const previous = Number(scope.files ?? 0)
      if (hash === lastSeenHash && files.length === previous) continue
      const delta = files.length - previous
      added = Math.max(0, delta)
      removed = Math.max(0, -delta)
      reason = `folder contents changed since last seed (files ${previous} -> ${files.length})`
    } else if (isFile(abs)) {
      const text = readFileSync(abs, "utf8")
      const hash = contentHash(text)
      const currentLines = text
        .split(/\r?\n/)
        .filter((line) => line.trim() !== "")
        .map((line) => contentHash(line))
      const diff = compareLineHashes(storedLines, currentLines)
      if (hash === lastSeenHash && diff.added === 0 && diff.removed === 0 && diff.changed === 0) continue
      added = diff.added
      removed = diff.removed
      changed = diff.changed
      reason = `file content changed since last seed (+${added}/-${removed}/~${changed})`
    } else {
      const previous = storedLines.length || Number(scope.files ?? 0)
      removed = previous
      reason = `seed scope path is missing (${path})`
    }

    const ref = normalizedRef(root, path)
    const agentAttributed = events.some((event) => {
      if (!event.ref || (seededAt && event.created_at <= seededAt)) return false
      const eventRef = normalizedRef(root, event.ref)
      return eventRef === ref || (isFolder && eventRef.startsWith(`${ref.replace(/\/$/, "")}/`))
    })
    out.push({ path, added, removed, changed, reason, agentAttributed })
  }
  return out
}

export function noteToolFileChange(db: DB, sessionID: string, file: string, summary: string): void {
  db.prepare(
    "INSERT INTO change_events (created_at, session_id, source, summary, ref) VALUES (?, ?, 'agent-tool', ?, ?)",
  ).run(nowISO(), sessionID, summary, file)
}

interface RemovalTarget {
  factId: number
  file: string
  line: string | null
}

/** Read-only inspection: which obsolete manifest lines can still be safely removed. */
function inspectRemovals(db: DB, root: string): RemovalTarget[] {
  const rows = db
    .prepare(
      `SELECT d.fact_id, d.file, d.line_hash, d.owner, m.content, m.kind, m.rank
       FROM doc_manifest d JOIN memories m ON m.id = d.fact_id
       WHERE m.obsolete_at IS NOT NULL AND d.owner = 'plugin'`,
    )
    .all() as any[]
  const out: RemovalTarget[] = []
  for (const row of rows) {
    const file = String(row.file)
    const abs = resolvePath(root, file)
    if (!isFile(abs)) continue
    const expected = renderBullet(String(row.content), row.kind as Kind, row.rank as Rank)
    const lines = readFileSync(abs, "utf8").replace(/\r\n/g, "\n").split("\n")
    const line = lines.find((candidate) => candidate === expected && contentHash(candidate) === row.line_hash)
    out.push({ factId: Number(row.fact_id), file, line: line ?? null })
  }
  return out
}

function selectedProposals(db: DB, ids?: number[]): DocUpdateRow[] {
  const proposals = listDocUpdates(db)
  if (!ids) return proposals
  const wanted = new Set(ids)
  return proposals.filter((p) => wanted.has(p.id))
}

function buildPlan(db: DB, root: string, ids?: number[]): DocPlan {
  const proposals = selectedProposals(db, ids)
  const byFile = new Map<string, number>()
  for (const proposal of proposals) byFile.set(proposal.file, (byFile.get(proposal.file) ?? 0) + 1)
  return {
    proposals,
    drift: scanDrift(db, root),
    writes: [...byFile].map(([file, added]) => ({ file, added })),
    removals: inspectRemovals(db, root)
      .filter((r) => r.line !== null)
      .map((r) => ({ file: r.file, content: r.line! })),
  }
}

/** Read-only preview of pending writes, removals and seed-scope drift. */
export function planDocs(db: DB, root: string): DocPlan {
  return buildPlan(db, root)
}

/** Append a bullet under `## heading`, preserving every existing line. */
function appendBullet(root: string, rel: string, heading: string, bullet: string): void {
  const abs = resolvePath(root, rel)
  mkdirSync(dirname(abs), { recursive: true })
  const text = isFile(abs) ? readFileSync(abs, "utf8") : ""
  const lines = text.replace(/\r\n/g, "\n").split("\n")
  if (lines.includes(bullet)) return
  if (text === "") {
    writeFileSync(abs, [`# ${fileTitle(rel)}`, "", `## ${heading}`, "", bullet, ""].join("\n"))
    return
  }
  const wanted = stripMarkdown(heading).toLowerCase()
  let sectionStart = -1
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^##\s+(.+?)\s*$/)
    if (match && stripMarkdown(match[1]).toLowerCase() === wanted) {
      sectionStart = i
      break
    }
  }
  if (sectionStart >= 0) {
    let insertAt = lines.length
    for (let i = sectionStart + 1; i < lines.length; i++) {
      if (/^#{1,6}\s+/.test(lines[i])) {
        insertAt = i
        break
      }
    }
    lines.splice(insertAt, 0, bullet)
  } else {
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
    lines.push("", `## ${heading}`, "", bullet, "")
  }
  writeFileSync(abs, lines.join("\n"))
}

function applyRemovals(db: DB, root: string, targets: RemovalTarget[]): number {
  const byFile = new Map<string, RemovalTarget[]>()
  for (const target of targets) {
    if (!byFile.has(target.file)) byFile.set(target.file, [])
    byFile.get(target.file)!.push(target)
  }
  let removed = 0
  for (const [file, entries] of byFile) {
    const abs = resolvePath(root, file)
    if (!isFile(abs)) continue
    const lines = readFileSync(abs, "utf8").replace(/\r\n/g, "\n").split("\n")
    const taken = new Set<number>()
    for (const entry of entries) {
      if (!entry.line) continue
      const idx = lines.findIndex((line, i) => !taken.has(i) && line === entry.line)
      if (idx >= 0) {
        taken.add(idx)
        removed++
      }
    }
    writeFileSync(abs, lines.filter((_line, i) => !taken.has(i)).join("\n"))
  }
  for (const entry of targets) {
    if (entry.line) db.prepare("DELETE FROM doc_manifest WHERE fact_id = ?").run(entry.factId)
  }
  return removed
}

/**
 * Apply the planned doc writes and obsolete-line removals. The returned plan is
 * the snapshot of what was executed (selected proposals, their writes, and the
 * safe removals that were performed).
 */
export function applyDocs(db: DB, root: string, ids?: number[]): DocPlan {
  const plan = buildPlan(db, root, ids)
  for (const proposal of plan.proposals) {
    const fact = getFact(db, proposal.factId)
    if (fact?.obsolete_at) {
      db.prepare("UPDATE pending_doc_updates SET status = 'applied' WHERE id = ?").run(proposal.id)
      continue
    }
    const kind = fact?.kind ?? kindFromFile(proposal.file)
    if (isManagedKind(kind) && !getTarget(db, kind).enabled) continue
    const bullet = renderBullet(proposal.content, kind, fact?.rank)
    const heading = proposal.heading || kindTitle(kind)
    appendBullet(root, proposal.file, heading, bullet)
    db.prepare(
      `INSERT INTO doc_manifest (fact_id, file, heading, line_hash, owner, origin, updated_at)
       VALUES (?, ?, ?, ?, 'plugin', ?, ?)
       ON CONFLICT(fact_id) DO UPDATE SET
         file = excluded.file, heading = excluded.heading, line_hash = excluded.line_hash,
         owner = 'plugin', origin = excluded.origin, updated_at = excluded.updated_at`,
    ).run(proposal.factId, proposal.file, heading, contentHash(bullet), fact?.origin ?? null, nowISO())
    db.prepare("UPDATE pending_doc_updates SET status = 'applied' WHERE id = ?").run(proposal.id)
  }

  const targets = inspectRemovals(db, root)
  applyRemovals(
    db,
    root,
    targets.filter((t) => t.line !== null),
  )
  for (const target of targets) {
    if (target.line) continue
    const abs = resolvePath(root, target.file)
    if (isFile(abs)) {
      db.prepare("UPDATE doc_manifest SET owner = 'user', updated_at = ? WHERE fact_id = ?").run(nowISO(), target.factId)
    }
  }
  return plan
}
