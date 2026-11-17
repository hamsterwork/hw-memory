import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { DB } from "./db.ts"
import { addFact, listChangelog } from "./core.ts"
import { contentHash, tokenize, todayISO } from "./util.ts"

export type ChangelogSource = "auto" | "git" | "journal"
export type ChangelogSummary = "deterministic" | "ai"

export interface ChangeAnchor {
  label: string
  commitSha: string | null
  journalSeq: number | null
  source: "git" | "journal" | "none"
}

export interface ChangeReport {
  text: string
  anchor: ChangeAnchor
  source: "git" | "journal"
  bullets: string[]
  count: number
  savedId: number | null
}

const VERSION_RE = /^v?[0-9A-Za-z._-]{1,64}$/
const MAX_BULLETS = 30
const CHANGELOG_REL = "docs/hw-memory/changelog.md"
const AI_PREFIX = "AI summarization requested; deterministic bullets below."
const GIT_ERROR_NOTE = "Git history is unavailable in this directory; no commits collected."
const noChangesNote = (label: string) => `No recorded changes since ${label}.`

interface GitCommit {
  hash: string
  subject: string
}

interface ParsedSubject {
  type: string
  scope: string
  text: string
}

/** Run an allowlisted git command. Never interpolates user text into a shell. */
function git(args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    })
  } catch {
    return null
  }
}

export function resolveAnchor(
  db: DB,
  root: string,
  version?: string,
  source: ChangelogSource = "auto",
): ChangeAnchor {
  let normalized: string | null = null
  if (version !== undefined) {
    if (typeof version !== "string" || !VERSION_RE.test(version)) {
      throw new Error(`Invalid version label: ${String(version).slice(0, 80)}`)
    }
    normalized = version.replace(/^v/, "")
  }

  if (normalized !== null) {
    // A git tag is the strongest anchor. The candidate strings are built from a
    // validated version only, so no user-controlled shell syntax can reach git.
    if (source !== "journal") {
      for (const tag of [normalized, `v${normalized}`]) {
        if (tag.startsWith("-")) continue
        const sha = git(["rev-parse", "--verify", `${tag}^{commit}`], root)
        if (sha && /^[0-9a-f]{7,64}$/i.test(sha.trim())) {
          return { label: normalized, commitSha: sha.trim(), journalSeq: null, source: "git" }
        }
      }
    }
    if (source !== "git") {
      for (const label of [normalized, `v${normalized}`]) {
        const row = db
          .prepare("SELECT commit_sha, journal_seq FROM version_checkpoints WHERE label = ?")
          .get(label) as any
        if (row) {
          const commitSha = (row.commit_sha ?? null) as string | null
          const journalSeq = (row.journal_seq ?? null) as number | null
          return { label: normalized, commitSha, journalSeq, source: commitSha ? "git" : "journal" }
        }
      }
    }
    // Unknown version: keep the requested label, fall back to the beginning.
    if (source === "git") return { label: normalized, commitSha: null, journalSeq: null, source: "none" }
    const first = git(["rev-list", "--max-parents=0", "HEAD"], root)
    if (first && first.trim()) {
      return { label: normalized, commitSha: first.trim().split(/\s+/)[0]!, journalSeq: null, source: "git" }
    }
    return { label: normalized, commitSha: null, journalSeq: 0, source: "journal" }
  }

  if (source !== "journal") {
    const first = git(["rev-list", "--max-parents=0", "HEAD"], root)
    if (first && first.trim()) {
      return { label: "beginning", commitSha: first.trim().split(/\s+/)[0]!, journalSeq: null, source: "git" }
    }
  }
  if (source === "git") return { label: "beginning", commitSha: null, journalSeq: null, source: "none" }
  return { label: "beginning", commitSha: null, journalSeq: 0, source: "journal" }
}

function readGitCommits(anchor: ChangeAnchor, root: string): { commits: GitCommit[]; error: string | null } {
  const range = anchor.commitSha ? `${anchor.commitSha}..HEAD` : "HEAD"
  let out: string
  try {
    out = execFileSync(
      "git",
      ["log", "--no-merges", "--date=short", "--pretty=format:%h%x1f%ad%x1f%s", range],
      { cwd: root, encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] },
    )
  } catch {
    return { commits: [], error: GIT_ERROR_NOTE }
  }
  const commits: GitCommit[] = []
  for (const line of out.split(/\r?\n/)) {
    if (!line.trim()) continue
    const parts = line.split("\x1f")
    const hash = (parts[0] ?? "").trim()
    const subject = parts.slice(2).join("\x1f").trim()
    if (!hash || !subject) continue
    commits.push({ hash, subject })
  }
  return { commits, error: null }
}

function parseSubject(subject: string): ParsedSubject {
  const m = subject.match(/^([A-Za-z][\w-]*)(\(([^)]*)\))?!?:\s*(.+)$/)
  if (!m) return { type: "", scope: "", text: subject.trim() }
  return { type: m[1]!.toLowerCase(), scope: m[3] ?? "", text: m[4]!.trim() }
}

function nearDuplicate(a: string, b: string): boolean {
  const na = a.trim().toLowerCase().replace(/\s+/g, " ")
  const nb = b.trim().toLowerCase().replace(/\s+/g, " ")
  if (na === nb) return true
  const ta = tokenize(na)
  const tb = tokenize(nb)
  if (ta.length === 0 || tb.length === 0) return false
  const setB = new Set(tb)
  const inter = ta.filter((t) => setB.has(t)).length
  const union = new Set([...ta, ...tb]).size
  const jaccard = union ? inter / union : 0
  const ratio = Math.min(ta.length, tb.length) / Math.max(ta.length, tb.length)
  return jaccard >= 0.85 || (inter === Math.min(ta.length, tb.length) && ratio >= 0.7)
}

function overflowBullet(beyond: number, noun: string): string {
  return `- … and ${beyond} more ${noun}`
}

function formatGitBullets(commits: GitCommit[]): string[] {
  // Stable sort: conventional commits are grouped by type, plain subjects follow.
  const ordered = [...commits].sort((a, b) => {
    const ta = parseSubject(a.subject).type || "\uffff"
    const tb = parseSubject(b.subject).type || "\uffff"
    return ta.localeCompare(tb)
  })
  const seenHashes = new Set<string>()
  const seenSubjects: string[] = []
  const kept: GitCommit[] = []
  for (const c of ordered) {
    const key = contentHash(c.subject)
    if (seenHashes.has(key)) continue
    if (seenSubjects.some((s) => nearDuplicate(s, c.subject))) continue
    seenHashes.add(key)
    seenSubjects.push(c.subject)
    kept.push(c)
  }
  const bullets: string[] = []
  for (const c of kept.slice(0, MAX_BULLETS)) {
    const { type, scope, text } = parseSubject(c.subject)
    const label = type ? `${type}${scope ? `(${scope})` : ""}: ${text}` : text
    bullets.push(`- ${label} (${c.hash})`)
  }
  const beyond = kept.length - MAX_BULLETS
  if (beyond > 0) bullets.push(overflowBullet(beyond, "commits"))
  return bullets
}

function formatJournalBullets(db: DB, anchor: ChangeAnchor): string[] {
  const rows = (anchor.journalSeq === null || anchor.journalSeq === 0
    ? db.prepare("SELECT summary FROM change_events ORDER BY seq ASC").all()
    : db.prepare("SELECT summary FROM change_events WHERE seq > ? ORDER BY seq ASC").all(anchor.journalSeq)) as any[]
  const seen = new Set<string>()
  const kept: string[] = []
  for (const r of rows) {
    const text = String(r.summary ?? "").trim().replace(/\s+/g, " ")
    if (!text) continue
    const key = contentHash(text)
    if (seen.has(key)) continue
    seen.add(key)
    kept.push(text)
  }
  if (kept.length === 0) return [`- ${noChangesNote(anchor.label)}`]
  const bullets = kept.slice(0, MAX_BULLETS).map((text) => `- ${text}`)
  const beyond = kept.length - MAX_BULLETS
  if (beyond > 0) bullets.push(overflowBullet(beyond, "changes"))
  return bullets
}

export function collectChanges(
  db: DB,
  root: string,
  version?: string,
  opts: {
    source?: ChangelogSource
    summary?: ChangelogSummary
    save?: boolean
    uncommitted?: string[]
  } = {},
): ChangeReport {
  const anchor = resolveAnchor(db, root, version, opts.source)
  const source: "git" | "journal" = anchor.source === "git" ? "git" : "journal"
  let bullets: string[] = []
  let note: string | null = null

  if (source === "git") {
    const result = readGitCommits(anchor, root)
    note = result.error
    if (!result.error) bullets = formatGitBullets(result.commits)
    if (!result.error && opts.uncommitted && opts.uncommitted.length > 0) {
      bullets.push("", "## Uncommitted", "")
      for (const line of opts.uncommitted) {
        const text = String(line).trim().replace(/\s+/g, " ")
        if (text) bullets.push(`- ${text}`)
      }
    }
  } else {
    bullets = formatJournalBullets(db, anchor)
  }

  const isPlaceholder =
    bullets.length === 0 || (bullets.length === 1 && bullets[0] === `- ${noChangesNote(anchor.label)}`)
  const rendered = bullets.join("\n")
  const text = [opts.summary === "ai" ? AI_PREFIX : null, note, rendered]
    .filter((part) => part !== null && part !== "")
    .join("\n")

  let savedId: number | null = null
  if (opts.save !== false && !isPlaceholder) savedId = saveChangelogFact(db, anchor, bullets)

  return {
    text,
    anchor,
    source,
    bullets,
    count: bullets.filter((b) => b.startsWith("- ")).length,
    savedId,
  }
}

export function saveChangelogFact(db: DB, anchor: ChangeAnchor, bullets: string[]): number {
  const content = bullets.join("\n").trim().slice(0, 4000)
  const id = addFact(db, {
    content,
    kind: "changelog",
    rank: "medium",
    source: "auto",
    origin: `changes:${anchor.label}..HEAD`,
    exact: true,
  }).id
  // addFact collapses whitespace for hashing; restore the readable bullet
  // layout in storage (content_hash is unchanged because normalizeContent
  // collapses the same whitespace).
  db.prepare("UPDATE memories SET content = ? WHERE id = ?").run(content, id)

  if (anchor.label !== "beginning") {
    const createdAt = new Date().toISOString()
    db.prepare(
      `INSERT INTO version_checkpoints (label, commit_sha, journal_seq, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(label) DO UPDATE SET
         commit_sha = excluded.commit_sha,
         journal_seq = excluded.journal_seq,
         created_at = excluded.created_at`,
    ).run(anchor.label, anchor.commitSha, anchor.journalSeq, createdAt)
  }
  return id
}

function labelFromOrigin(origin: string | null, createdAt: string): string {
  if (origin && origin.startsWith("changes:")) {
    const rest = origin.slice("changes:".length)
    if (rest.endsWith("..HEAD")) return rest.slice(0, -"..HEAD".length)
    return rest
  }
  return createdAt.slice(0, 10) || todayISO()
}

export function exportChangelog(db: DB, root: string): string {
  const lines: string[] = ["# Changelog", ""]
  for (const fact of listChangelog(db)) {
    lines.push(`## ${labelFromOrigin(fact.origin, fact.created_at)}`, "")
    const content = fact.content.trim()
    if (content) lines.push(content, "")
  }
  while (lines.length > 1 && lines[lines.length - 1] === "") lines.pop()
  lines.push("")

  const abs = join(root, CHANGELOG_REL)
  mkdirSync(join(abs, ".."), { recursive: true })
  writeFileSync(abs, lines.join("\n"))
  return CHANGELOG_REL
}

export function listCheckpoints(db: DB): {
  label: string
  commitSha: string | null
  journalSeq: number | null
  createdAt: string
}[] {
  const rows = db
    .prepare("SELECT label, commit_sha, journal_seq, created_at FROM version_checkpoints ORDER BY created_at ASC")
    .all() as any[]
  return rows.map((r) => ({
    label: r.label as string,
    commitSha: (r.commit_sha ?? null) as string | null,
    journalSeq: (r.journal_seq ?? null) as number | null,
    createdAt: r.created_at as string,
  }))
}
