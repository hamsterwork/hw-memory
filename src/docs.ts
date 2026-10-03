import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { DB } from "./db.ts"
import { isDir, isFile } from "./fs.ts"
import type { FactRow, Kind, Rank } from "./core.ts"
import { addFact } from "./core.ts"
import {
  DEFAULT_TARGET_PATH,
  getTarget,
  listTargets,
  MANAGED_KINDS,
  type FileTarget,
  type ManagedKind,
} from "./config.ts"
import { contentHash, keywordsFrom, parseVerifiedDate, stripMarkdown, titleFrom, tokenize, todayISO } from "./util.ts"

export interface DocFact {
  content: string
  hash: string
  keywords: string[]
  kind: Kind
  rank: Rank
  origin: string
  verified: string | null
}

export function managedRank(kind: ManagedKind): Rank {
  if (kind === "decision") return "critical"
  if (kind === "gotcha") return "high"
  return "medium"
}

export function rankForPath(rel: string): { kind: Kind; rank: Rank } | null {
  const p = rel.replaceAll("\\", "/").toLowerCase()
  if (p.startsWith(".memory/") || p.startsWith(".opencode/") || p.startsWith("node_modules/")) return null
  const base = p.split("/").pop() ?? p
  if (base === "decisions.md") return { kind: "decision", rank: "critical" }
  if (base === "gotchas.md") return { kind: "gotcha", rank: "high" }
  if (base === "debt.md") return { kind: "debt", rank: "medium" }
  if (base === "context.md") return { kind: "fact", rank: "high" }
  if (p.startsWith("docs/architecture/")) return { kind: "fact", rank: "high" }
  if (p.startsWith("docs/rules/")) return { kind: "decision", rank: "critical" }
  if (p.startsWith("docs/roles/")) return { kind: "fact", rank: "medium" }
  if (base === "changelog.md") return { kind: "changelog", rank: "low" }
  if (p === "agents.md" || p === "readme.md") return { kind: "fact", rank: "medium" }
  if (p.startsWith("docs/") && base.endsWith(".md")) return { kind: "fact", rank: "medium" }
  return null
}

function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "") || "doc"
  )
}

export function parseDocFile(
  absPath: string,
  rel: string,
  override?: { kind: Kind; rank: Rank },
): DocFact[] {
  const mapping = override ?? rankForPath(rel)
  if (!mapping) return []
  let text: string
  try {
    text = readFileSync(absPath, "utf8")
  } catch {
    return []
  }
  const facts: DocFact[] = []
  const lines = text.split(/\r?\n/)
  let inFence = false
  let section = ""
  let contextDate: string | null = null
  const stem = (rel.split("/").pop() ?? rel).replace(/\.md$/i, "")
  const anchorCounters = new Map<string, number>()
  for (const raw of lines) {
    const trimmed = raw.trim()
    if (/^(```|~~~)/.test(trimmed)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const lineDate = parseVerifiedDate(trimmed)
    if (lineDate) contextDate = lineDate
    if (trimmed.startsWith("|")) continue
    const heading = trimmed.match(/^#{1,6}\s+(.+)$/)
    if (heading) {
      section = stripMarkdown(heading[1])
      continue
    }
    const bullet = trimmed.match(/^(?:[-*+]|\d+[.)])\s+(.+)$/)
    if (!bullet) continue
    const numbered = trimmed.match(/^(\d+)[.)]\s+/)
    const content = stripMarkdown(bullet[1]).replace(/\s+/g, " ").trim()
    if (content.length < 25) continue
    const verified = parseVerifiedDate(content) ?? contextDate
    let anchor: string
    if (numbered) {
      anchor = numbered[1]
    } else {
      const base = slugify(section || stem)
      const n = (anchorCounters.get(base) ?? 0) + 1
      anchorCounters.set(base, n)
      anchor = `${base}-${n}`
    }
    const keywords = keywordsFrom(content, [stem, ...tokenize(section).slice(0, 3)])
    facts.push({
      content,
      hash: contentHash(content),
      keywords,
      kind: mapping.kind,
      rank: mapping.rank,
      origin: `${rel}#${anchor}`,
      verified,
    })
  }
  return facts
}

export interface DocFile {
  abs: string
  rel: string
  override?: { kind: Kind; rank: Rank }
}

export function discoverDocFiles(root: string, targets: FileTarget[] = []): DocFile[] {
  const out: DocFile[] = []
  const seen = new Set<string>()
  for (const rel of ["AGENTS.md", "README.md", "CHANGELOG.md"]) {
    const abs = join(root, rel)
    if (isFile(abs)) {
      out.push({ abs, rel })
      seen.add(rel)
    }
  }
  const docsDir = join(root, "docs")
  if (isDir(docsDir)) {
    for (const entry of readdirSync(docsDir, { recursive: true }) as string[]) {
      const rel = `docs/${entry.replaceAll("\\", "/")}`
      if (!rel.endsWith(".md")) continue
      if (seen.has(rel)) continue
      if (rankForPath(rel) === null) continue
      out.push({ abs: join(root, rel), rel })
      seen.add(rel)
    }
  }
  for (const t of targets) {
    if (!t.enabled || seen.has(t.path)) continue
    const abs = join(root, t.path)
    if (!isFile(abs)) continue
    out.push({ abs, rel: t.path, override: { kind: t.kind, rank: managedRank(t.kind) } })
    seen.add(t.path)
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel))
}

export interface SeedReport {
  files: number
  facts: number
  inserted: number
  updated: number
}

export function seedFromDocs(db: DB, root: string): SeedReport {
  const files = discoverDocFiles(root, listTargets(db))
  const report: SeedReport = { files: files.length, facts: 0, inserted: 0, updated: 0 }
  for (const f of files) {
    for (const doc of parseDocFile(f.abs, f.rel, f.override)) {
      report.facts++
      const res = addFact(db, {
        content: doc.content,
        keywords: doc.keywords,
        kind: doc.kind,
        rank: doc.rank,
        source: "seed",
        origin: doc.origin,
        verified: doc.verified ?? undefined,
      })
      if (res.status === "inserted") report.inserted++
      else report.updated++
    }
  }
  return report
}

export interface ReSeedReport {
  apply: boolean
  files: number
  docFacts: number
  inserted: number
  updatedContent: number
  rebound: number
  demoted: number
  unchanged: number
  missingFromDocs: { id: number; kind: string; rank: string; content: string }[]
}

function similarity(a: Set<string>, b: Set<string>): number {
  let inter = 0
  for (const t of a) if (b.has(t)) inter++
  const union = a.size + b.size - inter
  const jac = union === 0 ? 0 : inter / union
  const containment = inter / Math.min(a.size, b.size)
  return Math.max(jac, containment >= 0.9 ? containment : 0)
}

export function reSeedFromDocs(db: DB, root: string, apply = false): ReSeedReport {
  const files = discoverDocFiles(root, listTargets(db))
  const docFacts: DocFact[] = []
  for (const f of files) docFacts.push(...parseDocFile(f.abs, f.rel, f.override))
  const report: ReSeedReport = {
    apply,
    files: files.length,
    docFacts: docFacts.length,
    inserted: 0,
    updatedContent: 0,
    rebound: 0,
    demoted: 0,
    unchanged: 0,
    missingFromDocs: [],
  }
  const docByHash = new Map<string, DocFact>()
  for (const d of docFacts) if (!docByHash.has(d.hash)) docByHash.set(d.hash, d)
  const docByOrigin = new Map<string, DocFact>()
  for (const d of docFacts) if (!docByOrigin.has(d.origin)) docByOrigin.set(d.origin, d)
  const matched = new Set<string>()
  const usedOrigins = new Set<string>()
  const seedRows = db.prepare("SELECT * FROM memories WHERE source = 'seed'").all() as any[]
  for (const r of seedRows) {
    const row = r as unknown as FactRow
    const byHash = docByHash.get(row.content_hash)
    if (byHash) {
      matched.add(byHash.hash)
      usedOrigins.add(byHash.origin)
      if (byHash.origin !== row.origin) {
        report.rebound++
        if (apply) db.prepare("UPDATE memories SET origin = ?, last_verified_at = ? WHERE id = ?").run(byHash.origin, todayISO(), row.id)
      } else {
        report.unchanged++
      }
      continue
    }
    const byOrigin = usedOrigins.has(row.origin ?? "") ? undefined : docByOrigin.get(row.origin ?? "")
    if (byOrigin) {
      matched.add(byOrigin.hash)
      usedOrigins.add(byOrigin.origin)
      report.updatedContent++
      if (apply) {
        db.prepare(
          "UPDATE memories SET content = ?, content_hash = ?, keywords = ?, last_verified_at = ? WHERE id = ?",
        ).run(byOrigin.content, byOrigin.hash, byOrigin.keywords.join(","), byOrigin.verified ?? todayISO(), row.id)
      }
      continue
    }
    const rowTokens = new Set(tokenize(row.content))
    let best: DocFact | null = null
    let bestScore = 0
    for (const d of docFacts) {
      if (matched.has(d.hash) || d.kind !== row.kind) continue
      const score = similarity(rowTokens, new Set(tokenize(d.content)))
      if (score > bestScore) {
        bestScore = score
        best = d
      }
    }
    if (best && bestScore >= 0.75) {
      matched.add(best.hash)
      report.rebound++
      if (apply) {
        db.prepare(
          "UPDATE memories SET content = ?, content_hash = ?, keywords = ?, origin = ?, last_verified_at = ? WHERE id = ?",
        ).run(best.content, best.hash, best.keywords.join(","), best.origin, best.verified ?? todayISO(), row.id)
      }
      continue
    }
    report.demoted++
    if (apply) db.prepare("UPDATE memories SET rank = 'low', weight = 0.6 WHERE id = ?").run(row.id)
  }
  for (const d of docFacts) {
    if (matched.has(d.hash)) continue
    if (db.prepare("SELECT 1 FROM memories WHERE content_hash = ?").get(d.hash)) continue
    report.inserted++
    if (apply) {
      addFact(db, {
        content: d.content,
        keywords: d.keywords,
        kind: d.kind,
        rank: d.rank,
        source: "seed",
        origin: d.origin,
        verified: d.verified ?? undefined,
      })
    }
  }
  const crucial = db
    .prepare(
      "SELECT id, kind, rank, content FROM memories WHERE source != 'seed' AND origin IS NULL AND (kind IN ('decision','gotcha','debt') OR rank IN ('critical','high'))",
    )
    .all() as any[]
  report.missingFromDocs = crucial.map((c) => ({ id: c.id, kind: c.kind, rank: c.rank, content: c.content }))
  return report
}

function ensureDirFor(absPath: string): void {
  mkdirSync(join(absPath, ".."), { recursive: true })
}

function normalizedLines(text: string): string[] {
  const norm = text.endsWith("\n") ? text : text + "\n"
  return norm.split("\n")
}

function writeLines(absPath: string, lines: string[]): void {
  ensureDirFor(absPath)
  writeFileSync(absPath, lines.join("\n"))
}

export interface WriteResult {
  written: boolean
  origin: string
  file: string
}

function writeDecision(root: string, rel: string, content: string, title: string): WriteResult {
  const abs = join(root, rel)
  let text = ""
  if (isFile(abs)) text = readFileSync(abs, "utf8")
  let next = 1
  for (const m of text.matchAll(/^(\d+)[.)]\s+/gm)) next = Math.max(next, Number(m[1]) + 1)
  const item = `${next}. **${title}**: ${content}`
  if (text === "") {
    writeLines(abs, ["# Decisions", "", item, ""])
    return { written: true, origin: `${rel}#${next}`, file: rel }
  }
  const lines = normalizedLines(text)
  let insertAt = lines.length - 1
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s*(статус|status)\s*$/i.test(lines[i].trim())) {
      insertAt = i
      break
    }
  }
  lines.splice(insertAt, 0, item)
  writeLines(abs, lines)
  return { written: true, origin: `${rel}#${next}`, file: rel }
}

function writeMonthlyFile(root: string, rel: string, header: string, bullet: string): WriteResult {
  const abs = join(root, rel)
  const month = todayISO().slice(0, 7)
  if (!isFile(abs)) {
    writeLines(abs, [header, "", `## ${month}`, "", bullet, ""])
    return { written: true, origin: `${rel}#${month}`, file: rel }
  }
  const lines = normalizedLines(readFileSync(abs, "utf8"))
  let sectionStart = -1
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].trim().match(/^##\s+(\d{4}-\d{2})\s*$/)
    if (m) sectionStart = m[1] === month ? i : -1
  }
  if (sectionStart === -1) {
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
    lines.push("", `## ${month}`, "", bullet, "")
    writeLines(abs, lines)
    return { written: true, origin: `${rel}#${month}`, file: rel }
  }
  let insertAt = lines.length - 1
  for (let i = sectionStart + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i].trim())) {
      insertAt = i
      break
    }
  }
  lines.splice(insertAt, 0, bullet)
  writeLines(abs, lines)
  return { written: true, origin: `${rel}#${month}`, file: rel }
}

export function writeEntity(
  root: string,
  kind: ManagedKind,
  rel: string,
  content: string,
  rank: Rank,
  keywords: string[] = [],
): WriteResult {
  const title = titleFrom(content, keywords)
  if (kind === "decision") return writeDecision(root, rel, content, title)
  if (kind === "gotcha") return writeMonthlyFile(root, rel, "# Gotchas", `- **${title}**: ${content}`)
  return writeMonthlyFile(root, rel, "# Technical Debt", `- **[${rank}] ${title}**: ${content}`)
}

export interface SyncResult {
  file: string
  written: number
  origin: string
}

export function syncEntityToFile(db: DB, root: string, kind: ManagedKind): SyncResult {
  const target = getTarget(db, kind)
  if (!target.enabled) return { file: target.path, written: 0, origin: "" }
  const rel = target.path
  const abs = join(root, rel)
  let existingNorm = ""
  if (isFile(abs)) existingNorm = stripMarkdown(readFileSync(abs, "utf8"))
  const rows = (db.prepare("SELECT * FROM memories WHERE kind = ? ORDER BY created_at ASC").all(kind) as any[]).map(
    (r) => r as FactRow,
  )
  let written = 0
  let origin = ""
  for (const f of rows) {
    if (existingNorm.includes(f.content)) continue
    const res = writeEntity(root, kind, rel, f.content, f.rank, f.keywords ? f.keywords.split(",") : [])
    if (res.written) {
      written++
      origin = res.origin
      existingNorm = isFile(abs) ? stripMarkdown(readFileSync(abs, "utf8")) : `${existingNorm}\n${f.content}\n`
    }
  }
  return { file: rel, written, origin }
}

export interface ReworkResult {
  facts: number
  inserted: number
  updated: number
}

export function reworkFileIntoDb(db: DB, root: string, kind: ManagedKind, rel: string): ReworkResult {
  const abs = join(root, rel)
  const report: ReworkResult = { facts: 0, inserted: 0, updated: 0 }
  if (!isFile(abs)) return report
  const rank = managedRank(kind)
  for (const doc of parseDocFile(abs, rel, { kind, rank })) {
    report.facts++
    const res = addFact(db, {
      content: doc.content,
      keywords: doc.keywords,
      kind: doc.kind,
      rank: doc.rank,
      source: "seed",
      origin: doc.origin,
      verified: doc.verified ?? undefined,
    })
    if (res.status === "inserted") report.inserted++
    else report.updated++
  }
  return report
}

export function removeEntityLine(root: string, rel: string, content: string): boolean {
  const abs = join(root, rel)
  if (!isFile(abs)) return false
  const lines = normalizedLines(readFileSync(abs, "utf8"))
  const kept = lines.filter((l) => !stripMarkdown(l.trim()).includes(content))
  if (kept.length === lines.length) return false
  writeLines(abs, kept)
  return true
}

export function docsFooterLines(root: string, db?: DB): string[] {
  const items: { rel: string; note: string }[] = [
    { rel: "AGENTS.md", note: "bootstrap rules" },
    { rel: "docs/Changelog.md", note: "chronicle" },
    { rel: "docs/context.md", note: "environment reference" },
    { rel: "docs/architecture", note: "architecture reference" },
    { rel: "docs/roles", note: "audience-specific docs" },
  ]
  const managed: { rel: string; note: string }[] = db
    ? listTargets(db)
        .filter((t) => t.enabled)
        .map((t) => ({ rel: t.path, note: `${t.kind} write-back` }))
    : MANAGED_KINDS.map((k) => ({ rel: DEFAULT_TARGET_PATH[k], note: `${k} write-back` }))
  for (const m of managed) items.push(m)
  return items.filter((i) => existsSync(join(root, i.rel))).map((i) => `${i.rel} — ${i.note}`)
}
