import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { isDir, isFile } from "./fs.ts"
import type { DB } from "./db.ts"
import type { FactRow, Kind, Rank } from "./core.ts"
import { addFact } from "./core.ts"
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

export function rankForPath(rel: string): { kind: Kind; rank: Rank } | null {
  const p = rel.replaceAll("\\", "/").toLowerCase()
  if (p.startsWith(".memory/") || p.startsWith(".opencode/") || p.startsWith("node_modules/")) return null
  const base = p.split("/").pop() ?? p
  if (base === "decisions.md") return { kind: "decision", rank: "critical" }
  if (base === "gotchas.md") return { kind: "gotcha", rank: "high" }
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

export function parseDocFile(absPath: string, rel: string): DocFact[] {
  const mapping = rankForPath(rel)
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
}

export function discoverDocFiles(root: string): DocFile[] {
  const out: DocFile[] = []
  for (const rel of ["AGENTS.md", "README.md", "CHANGELOG.md"]) {
    const abs = join(root, rel)
    if (isFile(abs)) out.push({ abs, rel })
  }
  const docsDir = join(root, "docs")
  if (isDir(docsDir)) {
    for (const entry of readdirSync(docsDir, { recursive: true }) as string[]) {
      const rel = `docs/${entry.replaceAll("\\", "/")}`
      if (!rel.endsWith(".md")) continue
      out.push({ abs: join(root, rel), rel })
    }
  }
  return out
    .filter((f) => rankForPath(f.rel) !== null)
    .sort((a, b) => a.rel.localeCompare(b.rel))
}

export interface SeedReport {
  files: number
  facts: number
  inserted: number
  updated: number
}

export function seedFromDocs(db: DB, root: string): SeedReport {
  const files = discoverDocFiles(root)
  const report: SeedReport = { files: files.length, facts: 0, inserted: 0, updated: 0 }
  for (const f of files) {
    for (const doc of parseDocFile(f.abs, f.rel)) {
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
  const files = discoverDocFiles(root)
  const docFacts: DocFact[] = []
  for (const f of files) docFacts.push(...parseDocFile(f.abs, f.rel))
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
      "SELECT id, kind, rank, content FROM memories WHERE source != 'seed' AND origin IS NULL AND (kind IN ('decision','gotcha') OR rank IN ('critical','high'))",
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

export function writeCrucialToDocs(
  root: string,
  fact: { id: number; content: string; keywords: string[]; kind: Kind; rank: Rank },
): WriteResult {
  const title = titleFrom(fact.content, fact.keywords)
  if (fact.kind === "decision" || fact.rank === "critical") {
    return writeDecision(root, fact.content, title)
  }
  if (fact.kind === "gotcha") {
    return writeGotcha(root, fact.content, title)
  }
  if (fact.kind === "changelog") {
    return writeChangelog(root, fact.content)
  }
  return { written: false, origin: "", file: "" }
}

function writeDecision(root: string, content: string, title: string): WriteResult {
  const rel = "docs/decisions.md"
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

function writeGotcha(root: string, content: string, title: string): WriteResult {
  const rel = "docs/gotchas.md"
  const abs = join(root, rel)
  const month = todayISO().slice(0, 7)
  const bullet = `- **${title}**: ${content}`
  if (!isFile(abs)) {
    writeLines(abs, ["# Gotchas", "", `## ${month}`, "", bullet, ""])
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

function writeChangelog(root: string, content: string): WriteResult {
  const rel = "docs/Changelog.md"
  const abs = join(root, rel)
  const line = `- ${todayISO()}: ${content}`
  if (!isFile(abs)) {
    writeLines(abs, ["# Changelog", "", line, ""])
    return { written: true, origin: rel, file: rel }
  }
  const lines = normalizedLines(readFileSync(abs, "utf8"))
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
  lines.push(line, "")
  writeLines(abs, lines)
  return { written: true, origin: rel, file: rel }
}

export function docsFooterLines(root: string): string[] {
  const items: { rel: string; note: string }[] = [
    { rel: "AGENTS.md", note: "bootstrap rules" },
    { rel: "docs/decisions.md", note: "pinned decisions, critical" },
    { rel: "docs/gotchas.md", note: "resolved pitfalls, high" },
    { rel: "docs/Changelog.md", note: "chronicle" },
    { rel: "docs/context.md", note: "environment reference" },
    { rel: "docs/architecture", note: "architecture reference" },
    { rel: "docs/roles", note: "audience-specific docs" },
  ]
  return items.filter((i) => existsSync(join(root, i.rel))).map((i) => `${i.rel} — ${i.note}`)
}
