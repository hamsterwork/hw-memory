import { lstatSync, readdirSync, readFileSync, type Dirent } from "node:fs"
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path"
import {
  addFact,
  computeWeight,
  RANK_ORDER,
  type FactRow,
  type Kind,
  type Rank,
} from "./core.ts"
import type { DB } from "./db.ts"
import {
  contentHash,
  keywordsFrom,
  nowISO,
  parseVerifiedDate,
  similarityScore,
  stripMarkdown,
  tokenize,
  tokenSet,
} from "./util.ts"

export interface SeedCaps {
  files: number
  bytes: number
  depth: number
}

export const DEFAULT_SEED_CAPS: SeedCaps = { files: 200, bytes: 1_048_576, depth: 8 }

export interface SeedBlock {
  content: string
  heading: string
  anchor: string
  kind: Kind
  rank: Rank
  keywords: string[]
  verified: string | null
  line: number
  file: string
}

export type SeedChangeStatus =
  | "inserted"
  | "updated-content"
  | "rebound"
  | "demoted"
  | "unchanged"
  | "merged"
  | "skipped"

export interface SeedChange {
  block: SeedBlock
  status: SeedChangeStatus
  id?: number
  reason?: string
}

export interface SeedPlan {
  path: string
  isDir: boolean
  files: number
  skipped: number
  blocks: SeedBlock[]
  changes: SeedChange[]
  fileHash: string
  errors: string[]
}

const SKIP_DIRS = new Set([".git", "node_modules", ".opencode"])
const SUPPORTED_EXTENSIONS = new Set([".md", ".markdown", ".txt", ".rst"])

interface ScannedFile {
  abs: string
  rel: string
  text: string
  size: number
  mtimeMs: number
}

interface ScanResult {
  path: string
  isDir: boolean
  files: ScannedFile[]
  skipped: number
  errors: string[]
  fileHash: string
  lineHashes: string[]
  size: number
  mtimeMs: number
  valid: boolean
}

interface Classification {
  kind: Kind
  rank: Rank
  reason?: string
}

interface ParsedBlocks {
  blocks: SeedBlock[]
  reasons: Map<SeedBlock, string | undefined>
}

interface ScopeData {
  inScope: FactRow[]
  external: FactRow[]
  hashToRow: Map<string, FactRow>
}

interface ScopeRecord {
  path: string
  last_seen_hash: string
  line_hashes: string
  size: number
  mtime_ms: number
  files: number
  skipped: number
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function slab(path: string, valid: boolean): ScanResult {
  return {
    path,
    isDir: false,
    files: [],
    skipped: 0,
    errors: [],
    fileHash: "",
    lineHashes: [],
    size: 0,
    mtimeMs: 0,
    valid,
  }
}

function normalizeRelPath(input: string): { ok: boolean; value: string; error?: string } {
  if (typeof input !== "string" || input.includes("\0")) {
    return { ok: false, value: input, error: "invalid path" }
  }
  const trimmed = input.trim()
  if (!trimmed) return { ok: false, value: input, error: "empty path" }
  if (isAbsolute(trimmed) || /^[A-Za-z]:[\\/]/.test(trimmed)) {
    return { ok: false, value: input, error: "absolute paths are not allowed" }
  }
  let value = trimmed.replaceAll("\\", "/").replace(/^(?:\.\/)+/, "").replace(/\/+$/, "")
  if (value === "") value = "."
  if (value.split("/").includes("..")) {
    return { ok: false, value, error: "path escapes root" }
  }
  return { ok: true, value }
}

function resolveTarget(root: string, rel: string): { ok: boolean; abs: string; error?: string } {
  const rootAbs = resolve(root)
  const abs = resolve(rootAbs, rel === "." ? "." : rel)
  const check = relative(rootAbs, abs)
  if (check === ".." || check.startsWith(`..${sep}`) || isAbsolute(check)) {
    return { ok: false, abs, error: "path escapes root" }
  }
  return { ok: true, abs }
}

function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "") || "notes"
  )
}

const MARKERS: { re: RegExp; kind: Kind; rank: Rank }[] = [
  { re: /^\[decision\]/i, kind: "decision", rank: "high" },
  { re: /^decision\s*:/i, kind: "decision", rank: "high" },
  { re: /^\[gotcha\]/i, kind: "gotcha", rank: "high" },
  { re: /^gotcha\s*:/i, kind: "gotcha", rank: "high" },
  { re: /^pitfall\s*:/i, kind: "gotcha", rank: "high" },
  { re: /^\[debt\]/i, kind: "debt", rank: "medium" },
  { re: /^debt\s*:/i, kind: "debt", rank: "medium" },
  { re: /^\[reminder\]/i, kind: "reminder", rank: "medium" },
  { re: /^reminder\s*:/i, kind: "reminder", rank: "medium" },
  { re: /^todo\s*:/i, kind: "reminder", rank: "medium" },
  { re: /^open\s+question\s*:/i, kind: "reminder", rank: "medium" },
]

const HEURISTICS: { re: RegExp; kind: Kind; rank: Rank; label: string }[] = [
  {
    re: /\bdecided\b|\bwe(?:'ll| will)\s+use\b|\bswitch to\b/i,
    kind: "decision",
    rank: "high",
    label: "decision keywords",
  },
  {
    re: /\berror\b|\bfailed\b|\bpitfall\b|\bwatch out\b/i,
    kind: "gotcha",
    rank: "high",
    label: "gotcha keywords",
  },
  {
    re: /\brefactor\b|\bknown issue\b|\bworkaround\b|technical debt\b/i,
    kind: "debt",
    rank: "medium",
    label: "debt keywords",
  },
  {
    re: /\bneed to\b|\bfollow up\b|\blater\b|\binvestigate\b|\bquestion\b|\bplan\b/i,
    kind: "reminder",
    rank: "medium",
    label: "reminder keywords",
  },
]

function classify(content: string): Classification {
  for (const m of MARKERS) {
    if (m.re.test(content)) return { kind: m.kind, rank: m.rank }
  }
  for (const h of HEURISTICS) {
    if (h.re.test(content)) return { kind: h.kind, rank: h.rank, reason: `keyword: ${h.label}` }
  }
  return { kind: "reminder", rank: "medium", reason: "fallback: reminder/medium" }
}

function walkFolder(
  absDir: string,
  relDir: string,
  depth: number,
  caps: SeedCaps,
  files: ScannedFile[],
  errors: string[],
  skipped: { count: number },
): void {
  let entries: Dirent[]
  try {
    entries = readdirSync(absDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
  } catch (err) {
    errors.push(`${relDir || "."}: ${errorMessage(err)}`)
    return
  }
  const skip = (rel: string, reason: string) => {
    skipped.count++
    errors.push(`${rel}: skipped (${reason})`)
  }
  for (const entry of entries) {
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name
    const abs = join(absDir, entry.name)
    if (entry.isSymbolicLink()) {
      skip(rel, "symlink")
      continue
    }
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) {
        skip(rel, "excluded directory")
        continue
      }
      if (depth + 1 > caps.depth) {
        skip(rel, "depth cap")
        continue
      }
      walkFolder(abs, rel, depth + 1, caps, files, errors, skipped)
      continue
    }
    if (!entry.isFile()) {
      skip(rel, "unsupported file type")
      continue
    }
    if (!SUPPORTED_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      skip(rel, "unsupported extension")
      continue
    }
    if (depth + 1 > caps.depth) {
      skip(rel, "depth cap")
      continue
    }
    let st
    try {
      st = lstatSync(abs)
    } catch (err) {
      skip(rel, `unreadable (${errorMessage(err)})`)
      continue
    }
    if (st.size > caps.bytes) {
      skip(rel, `file exceeds ${caps.bytes} byte cap`)
      continue
    }
    if (files.length >= caps.files) {
      skip(rel, `file cap of ${caps.files} reached`)
      continue
    }
    let text: string
    try {
      text = readFileSync(abs, "utf8")
    } catch (err) {
      skip(rel, `unreadable (${errorMessage(err)})`)
      continue
    }
    if (text.includes("\0")) {
      skip(rel, "binary content")
      continue
    }
    files.push({ abs, rel, text, size: st.size, mtimeMs: st.mtimeMs })
  }
}

function scanPath(root: string, relPath: string, caps: SeedCaps): ScanResult {
  const norm = normalizeRelPath(relPath)
  const result = slab(norm.value, false)
  if (!norm.ok) {
    result.errors.push(norm.error ?? "invalid path")
    return result
  }
  const target = resolveTarget(root, norm.value)
  if (!target.ok) {
    result.errors.push(target.error ?? "path escapes root")
    return result
  }
  let st
  try {
    st = lstatSync(target.abs)
  } catch (err) {
    result.errors.push(`${norm.value}: ${errorMessage(err)}`)
    return result
  }
  if (st.isSymbolicLink()) {
    result.skipped = 1
    result.errors.push(`${norm.value}: skipped (symlink)`)
    return result
  }
  result.valid = true
  if (st.isFile()) {
    try {
      const text = readFileSync(target.abs, "utf8")
      result.files.push({ abs: target.abs, rel: norm.value, text, size: st.size, mtimeMs: st.mtimeMs })
    } catch (err) {
      result.valid = false
      result.errors.push(`${norm.value}: ${errorMessage(err)}`)
    }
  } else if (st.isDirectory()) {
    result.isDir = true
    const skipped = { count: 0 }
    walkFolder(target.abs, norm.value === "." ? "" : norm.value, 0, caps, result.files, result.errors, skipped)
    result.skipped = skipped.count
  } else {
    result.valid = false
    result.errors.push(`${norm.value}: unsupported file type`)
  }
  if (!result.valid) return result
  const lineHashes: string[] = []
  for (const file of result.files) {
    for (const raw of file.text.split(/\r?\n/)) {
      const line = stripMarkdown(raw.trim()).replace(/\s+/g, " ").trim()
      if (!line || /^(```|~~~)/.test(line)) continue
      lineHashes.push(contentHash(`${file.rel}\n${line}`))
    }
    result.size += file.size
    result.mtimeMs = Math.max(result.mtimeMs, file.mtimeMs)
  }
  result.fileHash = contentHash(result.files.map((f) => `${f.rel}\0${f.text}`).join("\n"))
  result.lineHashes = lineHashes
  return result
}

function parseBlocks(files: ScannedFile[]): ParsedBlocks {
  const blocks: SeedBlock[] = []
  const reasons = new Map<SeedBlock, string | undefined>()
  const headingRe = /^#{1,6}\s+(.+)$/
  const bulletRe = /^(?:[-*+]|\d+[.)])\s+(.+)$/
  const fenceRe = /^(```|~~~)/

  for (const file of files) {
    const lines = file.text.split(/\r?\n/)
    const stem = basename(file.rel, extname(file.rel))
    let heading = ""
    let contextDate: string | null = null
    let counter = 0
    let inFence = false

    const push = (rawContent: string, line: number) => {
      const content = stripMarkdown(rawContent).replace(/\s+/g, " ").trim()
      if (content.length < 25) return
      counter++
      const cls = classify(content)
      const block: SeedBlock = {
        content,
        heading,
        anchor: `${slugify(heading || stem)}-${counter}`,
        kind: cls.kind,
        rank: cls.rank,
        keywords: keywordsFrom(content, [stem, ...tokenize(heading).slice(0, 3)]),
        verified: parseVerifiedDate(content) ?? contextDate,
        line,
        file: file.rel,
      }
      blocks.push(block)
      reasons.set(block, cls.reason)
    }

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i]
      const trimmed = raw.trim()
      if (fenceRe.test(trimmed)) {
        inFence = !inFence
        continue
      }
      if (inFence) continue
      const seenDate = parseVerifiedDate(trimmed)
      if (seenDate) contextDate = seenDate
      const headingMatch = trimmed.match(headingRe)
      if (headingMatch) {
        heading = stripMarkdown(headingMatch[1]).replace(/\s+/g, " ").trim()
        continue
      }
      if (trimmed.startsWith("|")) continue
      if (trimmed === "") continue

      const bulletMatch = trimmed.match(bulletRe)
      if (bulletMatch) {
        let text = bulletMatch[1]
        let j = i + 1
        while (j < lines.length) {
          const next = lines[j]
          const nextTrimmed = next.trim()
          if (!nextTrimmed || !/^\s/.test(next)) break
          if (fenceRe.test(nextTrimmed) || bulletRe.test(nextTrimmed) || headingRe.test(nextTrimmed) || nextTrimmed.startsWith("|"))
            break
          const contDate = parseVerifiedDate(nextTrimmed)
          if (contDate) contextDate = contDate
          text += ` ${nextTrimmed}`
          j++
        }
        push(text, i + 1)
        i = j - 1
        continue
      }

      let text = trimmed
      let j = i + 1
      while (j < lines.length) {
        const next = lines[j]
        const nextTrimmed = next.trim()
        if (!nextTrimmed || fenceRe.test(nextTrimmed) || headingRe.test(nextTrimmed) || bulletRe.test(nextTrimmed) || nextTrimmed.startsWith("|"))
          break
        const contDate = parseVerifiedDate(nextTrimmed)
        if (contDate) contextDate = contDate
        text += ` ${nextTrimmed}`
        j++
      }
      push(text, i + 1)
      i = j - 1
    }
  }
  return { blocks, reasons }
}

function toFact(r: any): FactRow {
  return {
    id: r.id as number,
    content: r.content as string,
    content_hash: r.content_hash as string,
    keywords: (r.keywords ?? "") as string,
    kind: r.kind as Kind,
    rank: r.rank as Rank,
    weight: r.weight as number,
    accesses: r.accesses as number,
    source: r.source as "auto" | "agent" | "seed",
    origin: (r.origin ?? null) as string | null,
    scope: (r.scope ?? null) as string | null,
    obsolete_at: (r.obsolete_at ?? null) as string | null,
    last_verified_at: (r.last_verified_at ?? null) as string | null,
    last_checked_at: (r.last_checked_at ?? null) as string | null,
    created_at: r.created_at as string,
    last_accessed_at: (r.last_accessed_at ?? null) as string | null,
  }
}

function originInScope(origin: string | null, scope: string): boolean {
  if (!origin) return false
  const value = origin.replaceAll("\\", "/")
  return value === scope || value.startsWith(`${scope}/`) || value.startsWith(`${scope}#`)
}

function rowInScope(row: FactRow, scope: string): boolean {
  if (row.source !== "seed") return false
  if (row.scope) return row.scope === scope
  return originInScope(row.origin, scope)
}

function loadScopeData(db: DB, scope: string): ScopeData {
  const all = (db.prepare("SELECT * FROM memories").all() as any[]).map(toFact)
  const inScope = all.filter((r) => rowInScope(r, scope)).sort((a, b) => a.id - b.id)
  const inScopeIds = new Set(inScope.map((r) => r.id))
  const external = all.filter((r) => !inScopeIds.has(r.id))
  const hashToRow = new Map<string, FactRow>()
  for (const r of inScope) if (!hashToRow.has(r.content_hash)) hashToRow.set(r.content_hash, r)
  return { inScope, external, hashToRow }
}

function blockFromRow(row: FactRow): SeedBlock {
  const origin = row.origin ?? ""
  const hashAt = origin.indexOf("#")
  return {
    content: row.content,
    heading: "",
    anchor: hashAt >= 0 ? origin.slice(hashAt + 1) : "",
    kind: row.kind,
    rank: row.rank,
    keywords: row.keywords ? row.keywords.split(",").map((k) => k.trim()).filter(Boolean) : [],
    verified: row.last_verified_at,
    line: 0,
    file: hashAt >= 0 ? origin.slice(0, hashAt) : origin,
  }
}

function mergeDuplicate(db: DB, owner: FactRow, drop: FactRow): void {
  const rank = (RANK_ORDER[owner.rank] >= RANK_ORDER[drop.rank] ? owner.rank : drop.rank) as Rank
  const accesses = owner.accesses + drop.accesses
  db.prepare("UPDATE memories SET rank = ?, accesses = ?, weight = ? WHERE id = ?").run(
    rank,
    accesses,
    computeWeight(rank, accesses, 0),
    owner.id,
  )
  db.prepare("DELETE FROM memories WHERE id = ?").run(drop.id)
}

function computeChanges(
  db: DB,
  parsed: ParsedBlocks,
  scope: string,
  data: ScopeData,
  apply: boolean,
): SeedChange[] {
  const changes: SeedChange[] = []
  const externalHashes = new Set(data.external.map((r) => r.content_hash))
  const externalOrigins = new Set(data.external.map((r) => r.origin).filter((o): o is string => !!o))

  const blockHash = new Map<SeedBlock, string>()
  const blocksByHash = new Map<string, SeedBlock[]>()
  const blockByOrigin = new Map<string, SeedBlock>()
  for (const block of parsed.blocks) {
    const hash = contentHash(block.content)
    const origin = `${block.file}#${block.anchor}`
    blockHash.set(block, hash)
    const sameHash = blocksByHash.get(hash) ?? []
    sameHash.push(block)
    blocksByHash.set(hash, sameHash)
    if (!blockByOrigin.has(origin)) blockByOrigin.set(origin, block)
  }

  const claimed = new Set<SeedBlock>()
  const claimedHashes = new Set<string>()
  const matchedRows = new Set<number>()

  const addChange = (block: SeedBlock, status: SeedChangeStatus, id?: number, reason?: string): SeedChange => {
    const change: SeedChange = { block, status }
    if (id !== undefined) change.id = id
    const finalReason = reason ?? parsed.reasons.get(block)
    if (finalReason) change.reason = finalReason
    changes.push(change)
    return change
  }
  const claim = (block: SeedBlock) => {
    claimed.add(block)
    claimedHashes.add(blockHash.get(block) ?? "")
  }
  const originOf = (block: SeedBlock) => `${block.file}#${block.anchor}`

  const writeContent = (row: FactRow, block: SeedBlock, hash: string) => {
    if (!apply) return
    db.prepare(
      `UPDATE memories
         SET content = ?, content_hash = ?, keywords = ?, kind = ?, rank = ?, weight = ?,
             scope = ?, origin = ?, last_verified_at = ?
       WHERE id = ?`,
    ).run(
      block.content,
      hash,
      block.keywords.join(","),
      block.kind,
      block.rank,
      computeWeight(block.rank, row.accesses, 0),
      scope,
      originOf(block),
      block.verified ?? row.last_verified_at,
      row.id,
    )
  }
  const writeOriginOnly = (row: FactRow, block: SeedBlock) => {
    if (!apply) return
    db.prepare("UPDATE memories SET scope = ?, origin = ?, last_verified_at = ? WHERE id = ?").run(
      scope,
      originOf(block),
      block.verified ?? row.last_verified_at,
      row.id,
    )
  }
  const restoreRow = (row: FactRow) => {
    if (!apply) return
    db.prepare("UPDATE memories SET scope = ?, origin = ? WHERE id = ?").run(scope, row.origin, row.id)
  }
  const demoteRow = (row: FactRow) => {
    if (!apply) return
    db.prepare("UPDATE memories SET rank = 'low', weight = ?, scope = ?, origin = ? WHERE id = ?").run(
      computeWeight("low", row.accesses, 0),
      scope,
      row.origin,
      row.id,
    )
  }

  // Pass 1: exact content hashes claim blocks first so a lower-id row cannot
  // steal a content_hash still held by another scoped row.
  for (const row of data.inScope) {
    const allWithHash = blocksByHash.get(row.content_hash) ?? []
    if (allWithHash.length === 0) continue
    const candidates = allWithHash.filter((b) => !claimed.has(b))
    if (candidates.length === 0) {
      const block = allWithHash[0]
      addChange(block, "merged", row.id, "duplicate content")
      if (apply) {
        const owner = data.hashToRow.get(row.content_hash)
        if (owner && owner.id !== row.id) mergeDuplicate(db, owner, row)
      }
      matchedRows.add(row.id)
      continue
    }
    const block = candidates.find((b) => originOf(b) === row.origin) ?? candidates[0]
    claim(block)
    matchedRows.add(row.id)
    if (originOf(block) === row.origin) {
      addChange(block, "unchanged", row.id)
      writeOriginOnly(row, block)
    } else {
      addChange(block, "rebound", row.id)
      writeContent(row, block, blockHash.get(block) ?? "")
    }
  }

  // Pass 2: edited at the same origin, moved by token similarity, or vanished.
  for (const row of data.inScope) {
    if (matchedRows.has(row.id)) continue
    const byOrigin = blockByOrigin.get(row.origin ?? "")
    if (byOrigin && !claimed.has(byOrigin)) {
      const hash = blockHash.get(byOrigin) ?? ""
      if (externalHashes.has(hash) || claimedHashes.has(hash)) {
        addChange(byOrigin, "skipped", row.id, "content hash owned by another row")
        restoreRow(row)
        matchedRows.add(row.id)
        continue
      }
      claim(byOrigin)
      matchedRows.add(row.id)
      addChange(byOrigin, "updated-content", row.id)
      writeContent(row, byOrigin, hash)
      continue
    }

    const rowTokens = tokenSet(row.content)
    let best: SeedBlock | null = null
    let bestScore = 0
    for (const block of parsed.blocks) {
      if (claimed.has(block) || block.kind !== row.kind) continue
      const hash = blockHash.get(block) ?? ""
      if (externalHashes.has(hash) || claimedHashes.has(hash)) continue
      if (externalOrigins.has(originOf(block))) continue
      const score = similarityScore(rowTokens, tokenSet(block.content))
      if (score > bestScore) {
        bestScore = score
        best = block
      }
    }
    if (best && bestScore >= 0.75) {
      claim(best)
      matchedRows.add(row.id)
      addChange(best, "rebound", row.id)
      writeContent(row, best, blockHash.get(best) ?? "")
      continue
    }

    const synthetic = blockFromRow(row)
    if (row.rank === "low") {
      addChange(synthetic, "unchanged", row.id, "already low")
      restoreRow(row)
    } else {
      addChange(synthetic, "demoted", row.id, "no longer present in source")
      demoteRow(row)
    }
  }

  // Remaining blocks are new unless their hash/origin belongs to another scope
  // (or they are duplicates inside this scope).
  for (const block of parsed.blocks) {
    if (claimed.has(block)) continue
    const hash = blockHash.get(block) ?? ""
    if (claimedHashes.has(hash)) {
      addChange(block, "skipped", undefined, "duplicate content")
      continue
    }
    if (externalHashes.has(hash)) {
      addChange(block, "skipped", undefined, "content hash owned by another scope")
      continue
    }
    if (externalOrigins.has(originOf(block))) {
      addChange(block, "skipped", undefined, "origin owned by another scope")
      continue
    }
    let id: number | undefined
    if (apply) {
      const res = addFact(db, {
        content: block.content,
        keywords: block.keywords,
        kind: block.kind,
        rank: block.rank,
        source: "seed",
        origin: originOf(block),
        scope,
        verified: block.verified ?? undefined,
        exact: true,
      })
      id = res.id
    }
    claim(block)
    addChange(block, "inserted", id)
  }
  return changes
}

function upsertScope(db: DB, scan: ScanResult): void {
  const now = nowISO()
  db.prepare(
    `INSERT INTO seed_scopes
       (path, kind, last_seen_hash, last_seeded_hash, size, mtime_ms, files, skipped, line_hashes, last_seeded_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET
       kind = excluded.kind,
       last_seen_hash = excluded.last_seen_hash,
       last_seeded_hash = excluded.last_seeded_hash,
       size = excluded.size,
       mtime_ms = excluded.mtime_ms,
       files = excluded.files,
       skipped = excluded.skipped,
       line_hashes = excluded.line_hashes,
       last_seeded_at = excluded.last_seeded_at`,
  ).run(
    scan.path,
    scan.isDir ? "dir" : "file",
    scan.fileHash,
    scan.fileHash,
    scan.size,
    Math.round(scan.mtimeMs),
    scan.files.length,
    scan.skipped,
    JSON.stringify(scan.lineHashes),
    now,
    now,
  )
}

function makePlan(scan: ScanResult, blocks: SeedBlock[], changes: SeedChange[]): SeedPlan {
  return {
    path: scan.path,
    isDir: scan.isDir,
    files: scan.files.length,
    skipped: scan.skipped,
    blocks,
    changes,
    fileHash: scan.fileHash,
    errors: scan.errors,
  }
}

export function planSeed(db: DB, root: string, relPath: string, caps: SeedCaps = DEFAULT_SEED_CAPS): SeedPlan {
  const scan = scanPath(root, relPath, caps)
  if (!scan.valid) return makePlan(scan, [], [])
  const parsed = parseBlocks(scan.files)
  const scope = scan.path
  const changes = computeChanges(db, parsed, scope, loadScopeData(db, scope), false)
  return makePlan(scan, parsed.blocks, changes)
}

export function applySeed(db: DB, root: string, relPath: string, caps: SeedCaps = DEFAULT_SEED_CAPS): SeedPlan {
  const scan = scanPath(root, relPath, caps)
  if (!scan.valid) return makePlan(scan, [], [])
  const parsed = parseBlocks(scan.files)
  const scope = scan.path
  const data = loadScopeData(db, scope)
  let changes: SeedChange[] = []

  db.exec("BEGIN")
  try {
    // Clear only this scope's origins: reassigning them in place can violate
    // the partial unique index when one row's new origin is still held by
    // another row that is itself being rebound.
    for (const row of data.inScope) {
      db.prepare("UPDATE memories SET origin = NULL WHERE id = ?").run(row.id)
    }
    changes = computeChanges(db, parsed, scope, data, true)
    upsertScope(db, scan)
    db.exec("COMMIT")
  } catch (err) {
    db.exec("ROLLBACK")
    throw err
  }
  return makePlan(scan, parsed.blocks, changes)
}

function parseLineHashes(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : []
  } catch {
    return []
  }
}

function lineDiff(stored: string[], current: string[]): { added: number; removed: number; changed: number } {
  const remaining = new Map<string, number>()
  for (const hash of stored) remaining.set(hash, (remaining.get(hash) ?? 0) + 1)
  let common = 0
  for (const hash of current) {
    const left = remaining.get(hash) ?? 0
    if (left > 0) {
      remaining.set(hash, left - 1)
      common++
    }
  }
  const added = current.length - common
  const removed = stored.length - common
  return { added, removed, changed: Math.min(added, removed) }
}

export function changedSeedScopes(
  db: DB,
  root: string,
  force = false,
): { path: string; reason: string; added: number; removed: number; changed: number }[] {
  const scopes = db.prepare("SELECT * FROM seed_scopes ORDER BY path").all() as ScopeRecord[]
  const out: { path: string; reason: string; added: number; removed: number; changed: number }[] = []
  for (const scope of scopes) {
    const scan = scanPath(root, scope.path, DEFAULT_SEED_CAPS)
    const diff = lineDiff(parseLineHashes(scope.line_hashes), scan.lineHashes)
    const hashChanged = scan.valid && scan.fileHash !== scope.last_seen_hash
    const hasLineChanges = diff.added > 0 || diff.removed > 0
    if (!force && scan.valid && !hashChanged && !hasLineChanges) continue
    let reason: string
    if (!scan.valid) {
      reason = `unreadable: ${scan.errors.join("; ") || "missing"}`
    } else if (force && !hashChanged && !hasLineChanges) {
      reason = "forced"
    } else {
      reason = hashChanged ? "hash changed" : "lines changed"
      if (hasLineChanges || diff.changed > 0) {
        reason += ` (added=${diff.added}, removed=${diff.removed}, changed=${diff.changed})`
      }
    }
    out.push({
      path: scope.path,
      reason,
      added: scan.valid ? diff.added : 0,
      removed: scan.valid ? diff.removed : 0,
      changed: scan.valid ? diff.changed : 0,
    })
  }
  return out
}

export function resetSeedScopes(db: DB): void {
  db.exec("DELETE FROM seed_scopes")
}
