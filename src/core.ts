import type { DB } from "./db.ts"
import { contentHash, daysSince, ftsQuery, nowISO, tokenize, tokenSet } from "./util.ts"

export type Rank = "critical" | "high" | "medium" | "low"
export type Kind = "decision" | "gotcha" | "error" | "dependency" | "fact" | "changelog"
export type Source = "auto" | "agent" | "seed"

export const BASE_RATE = 0.008
export const PRUNE_WEIGHT = 0.2
export const CAP_ROWS = 500

export const RANK_TABLE: Record<Rank, { init: number; rate: number; prunable: boolean }> = {
  critical: { init: 1.0, rate: 0, prunable: false },
  high: { init: 1.0, rate: BASE_RATE * 0.5, prunable: false },
  medium: { init: 1.0, rate: BASE_RATE, prunable: true },
  low: { init: 0.6, rate: BASE_RATE * 2, prunable: true },
}

export const RANK_ORDER: Record<Rank, number> = { critical: 3, high: 2, medium: 1, low: 0 }

export interface FactRow {
  id: number
  content: string
  content_hash: string
  keywords: string
  kind: Kind
  rank: Rank
  weight: number
  accesses: number
  source: Source
  origin: string | null
  last_verified_at: string | null
  created_at: string
  last_accessed_at: string | null
}

export interface AddInput {
  content: string
  keywords?: string[]
  kind?: Kind
  rank?: Rank
  source?: Source
  origin?: string
  verified?: string
}

export interface AddResult {
  status: "inserted" | "updated"
  id: number
  kind: Kind
  rank: Rank
  crucial: boolean
  promoted: boolean
}

export function isCrucial(kind: Kind, rank: Rank): boolean {
  return kind === "decision" || kind === "gotcha" || rank === "critical" || rank === "high"
}

export function promoteRank(rank: Rank, accesses: number): Rank {
  if (rank === "low" && accesses >= 4) return "medium"
  if (rank === "medium" && accesses >= 8) return "high"
  return rank
}

export function initSchema(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL UNIQUE,
      keywords TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT 'fact',
      rank TEXT NOT NULL DEFAULT 'medium',
      weight REAL NOT NULL DEFAULT 1.0,
      accesses INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'auto',
      origin TEXT DEFAULT NULL,
      last_verified_at TEXT DEFAULT NULL,
      created_at TEXT NOT NULL,
      last_accessed_at TEXT DEFAULT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      content, keywords, content='memories', content_rowid='id'
    );
    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content, keywords) VALUES (new.id, new.content, new.keywords);
    END;
    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, keywords) VALUES ('delete', old.id, old.content, old.keywords);
    END;
    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF content, keywords ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, keywords) VALUES ('delete', old.id, old.content, old.keywords);
      INSERT INTO memories_fts(rowid, content, keywords) VALUES (new.id, new.content, new.keywords);
    END;
  `)
}

export function effectiveAgeDays(row: Pick<FactRow, "created_at" | "last_verified_at">): number {
  const from = row.last_verified_at && row.last_verified_at > row.created_at ? row.last_verified_at : row.created_at
  return daysSince(from)
}

export function computeWeight(rank: Rank, accesses: number, ageDays: number): number {
  const r = RANK_TABLE[rank]
  return r.init * Math.exp((-r.rate * ageDays) / (1 + 0.1 * accesses))
}

function rowToFact(r: any): FactRow {
  return {
    id: r.id as number,
    content: r.content as string,
    content_hash: r.content_hash as string,
    keywords: (r.keywords ?? "") as string,
    kind: r.kind as Kind,
    rank: r.rank as Rank,
    weight: r.weight as number,
    accesses: r.accesses as number,
    source: r.source as Source,
    origin: (r.origin ?? null) as string | null,
    last_verified_at: (r.last_verified_at ?? null) as string | null,
    created_at: r.created_at as string,
    last_accessed_at: (r.last_accessed_at ?? null) as string | null,
  }
}

export function getFact(db: DB, id: number): FactRow | null {
  const r = db.prepare("SELECT * FROM memories WHERE id = ?").get(id)
  return r ? rowToFact(r) : null
}

export function countFacts(db: DB): number {
  return (db.prepare("SELECT COUNT(*) AS c FROM memories").get() as any).c as number
}

export function findSimilar(db: DB, content: string, kind: Kind): FactRow | null {
  const hash = contentHash(content)
  const exact = db.prepare("SELECT * FROM memories WHERE content_hash = ?").get(hash)
  if (exact) return rowToFact(exact)
  const target = tokenSet(content)
  if (target.size === 0) return null
  const rows = db.prepare("SELECT * FROM memories WHERE kind = ?").all(kind) as any[]
  let best: FactRow | null = null
  let bestScore = 0
  for (const r of rows) {
    const other = new Set(tokenize(r.content))
    let inter = 0
    for (const t of target) if (other.has(t)) inter++
    const union = target.size + other.size - inter
    const jac = union === 0 ? 0 : inter / union
    const containment = inter / Math.min(target.size, other.size)
    const score = Math.max(jac, containment >= 0.9 ? containment : 0)
    if (score > bestScore) {
      bestScore = score
      best = rowToFact(r)
    }
  }
  return bestScore >= 0.85 ? best : null
}

export function addFact(db: DB, input: AddInput): AddResult {
  const content = input.content.trim().replace(/\s+/g, " ")
  const kind = input.kind ?? "fact"
  const dup = findSimilar(db, content, kind)
  const now = nowISO()
  if (dup) {
    const accesses = dup.accesses + 1
    let rank = dup.rank
    if (input.rank && RANK_ORDER[input.rank] > RANK_ORDER[rank]) rank = input.rank
    const promoted = rank !== dup.rank
    rank = promoteRank(rank, accesses)
    const keywords = mergeKeywords(dup.keywords, input.keywords ?? [])
    const weight = computeWeight(rank, accesses, 0)
    db.prepare(
      `UPDATE memories SET accesses = ?, rank = ?, keywords = ?, weight = ?,
       last_verified_at = COALESCE(?, last_verified_at), last_accessed_at = ? WHERE id = ?`,
    ).run(accesses, rank, keywords, weight, input.verified ?? null, now, dup.id)
    return { status: "updated", id: dup.id, kind: dup.kind, rank, crucial: isCrucial(dup.kind, rank), promoted }
  }
  const rank = input.rank ?? "medium"
  const weight = RANK_TABLE[rank].init
  const info = db
    .prepare(
      `INSERT INTO memories (content, content_hash, keywords, kind, rank, weight, accesses, source, origin, last_verified_at, created_at, last_accessed_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
    )
    .run(
      content,
      contentHash(content),
      (input.keywords ?? []).join(","),
      kind,
      rank,
      weight,
      input.source ?? "auto",
      input.origin ?? null,
      input.verified ?? null,
      now,
      now,
    ) as any
  const id = Number(info.lastInsertRowid ?? 0)
  return { status: "inserted", id, kind, rank, crucial: isCrucial(kind, rank), promoted: false }
}

function mergeKeywords(existing: string, extra: string[]): string {
  const merged = [...existing.split(",").map((k) => k.trim()).filter(Boolean)]
  for (const k of extra) {
    if (!merged.includes(k)) merged.push(k)
  }
  return merged.slice(0, 8).join(",")
}

export interface SearchOptions {
  limit?: number
  kinds?: Kind[]
  rankMin?: Rank
}

export interface ScoredFact extends FactRow {
  score: number
}

export function searchFacts(db: DB, query: string, opts: SearchOptions = {}): ScoredFact[] {
  const q = ftsQuery(query)
  if (!q) return []
  const limit = opts.limit ?? 5
  let hits: { id: number; bm: number }[]
  try {
    hits = (db
      .prepare("SELECT rowid AS id, bm25(memories_fts) AS bm FROM memories_fts WHERE memories_fts MATCH ? ORDER BY bm LIMIT 60")
      .all(q) as any[]).map((r) => ({ id: r.id as number, bm: r.bm as number }))
  } catch {
    return []
  }
  if (hits.length === 0) return []
  const facts = hits
    .map((h) => ({ fact: getFact(db, h.id), bm: h.bm }))
    .filter((x): x is { fact: FactRow; bm: number } => x.fact !== null)
    .filter((x) => (opts.kinds ? opts.kinds.includes(x.fact.kind) : true))
    .filter((x) => (opts.rankMin ? RANK_ORDER[x.fact.rank] >= RANK_ORDER[opts.rankMin] : true))
  if (facts.length === 0) return []
  const minBm = Math.min(...facts.map((f) => f.bm))
  const scored = facts.map((f) => {
    const normBm = minBm < 0 ? f.bm / minBm : 1
    return { ...f.fact, score: 0.7 * normBm + 0.3 * f.fact.weight }
  })
  scored.sort((a, b) => b.score - a.score)
  const top = scored.slice(0, limit)
  const now = nowISO()
  for (const f of top) {
    const accesses = f.accesses + 1
    const rank = promoteRank(f.rank, accesses)
    const weight = computeWeight(rank, accesses, effectiveAgeDays(f))
    db.prepare("UPDATE memories SET accesses = ?, rank = ?, weight = ?, last_accessed_at = ? WHERE id = ?").run(
      accesses,
      rank,
      weight,
      now,
      f.id,
    )
  }
  return top
}

export interface MaintainReport {
  decayed: number
  pruned: number
  capped: number
  promoted: number
  total: number
}

const lastMaintain = new WeakMap<DB, number>()

export function maintain(db: DB, force = false): MaintainReport {
  const now = Date.now()
  if (!force && lastMaintain.has(db) && now - (lastMaintain.get(db) as number) < 3_600_000) {
    return { decayed: 0, pruned: 0, capped: 0, promoted: 0, total: countFacts(db) }
  }
  lastMaintain.set(db, now)
  const report: MaintainReport = { decayed: 0, pruned: 0, capped: 0, promoted: 0, total: 0 }
  const rows = db.prepare("SELECT * FROM memories").all() as any[]
  const updates: { id: number; rank: Rank; weight: number }[] = []
  const pruneIds: number[] = []
  for (const r of rows) {
    const fact = rowToFact(r)
    let rank = promoteRank(fact.rank, fact.accesses)
    const weight = computeWeight(rank, fact.accesses, effectiveAgeDays(fact))
    if (rank !== fact.rank) report.promoted++
    if (RANK_TABLE[rank].prunable && weight < PRUNE_WEIGHT) {
      pruneIds.push(fact.id)
      continue
    }
    if (Math.abs(weight - fact.weight) > 0.0001 || rank !== fact.rank) {
      updates.push({ id: fact.id, rank, weight })
    }
  }
  report.decayed = updates.length
  for (const u of updates) {
    db.prepare("UPDATE memories SET weight = ?, rank = ? WHERE id = ?").run(u.weight, u.rank, u.id)
  }
  for (const id of pruneIds) {
    db.prepare("DELETE FROM memories WHERE id = ?").run(id)
  }
  report.pruned = pruneIds.length
  let total = countFacts(db)
  if (total > CAP_ROWS) {
    const extra = (db
      .prepare(
        `SELECT id FROM memories WHERE rank IN ('medium','low') ORDER BY weight ASC, accesses ASC LIMIT ?`,
      )
      .all(total - CAP_ROWS) as any[]).map((r) => r.id as number)
    for (const id of extra) db.prepare("DELETE FROM memories WHERE id = ?").run(id)
    report.capped = extra.length
    total = countFacts(db)
  }
  report.total = total
  return report
}

export function forgetFact(db: DB, id: number): boolean {
  const res = db.prepare("DELETE FROM memories WHERE id = ?").run(id) as any
  return (res.changes ?? 0) > 0
}

export function forgetKind(db: DB, kind: Kind): number {
  const res = db.prepare("DELETE FROM memories WHERE kind = ? AND rank NOT IN ('critical','high')").run(kind) as any
  return res.changes ?? 0
}

export interface StatsReport {
  total: number
  byRank: Record<string, number>
  byKind: Record<string, number>
  bySource: Record<string, number>
  avgWeight: number
  oldest: string | null
}

export function statsFacts(db: DB): StatsReport {
  const rows = db.prepare("SELECT rank, kind, source, weight, created_at FROM memories").all() as any[]
  const byRank: Record<string, number> = {}
  const byKind: Record<string, number> = {}
  const bySource: Record<string, number> = {}
  let weightSum = 0
  let oldest: string | null = null
  for (const r of rows) {
    byRank[r.rank] = (byRank[r.rank] ?? 0) + 1
    byKind[r.kind] = (byKind[r.kind] ?? 0) + 1
    bySource[r.source] = (bySource[r.source] ?? 0) + 1
    weightSum += r.weight
    if (!oldest || r.created_at < oldest) oldest = r.created_at
  }
  return {
    total: rows.length,
    byRank,
    byKind,
    bySource,
    avgWeight: rows.length ? weightSum / rows.length : 0,
    oldest,
  }
}

export function wakeUpPack(db: DB, docsFooter: string[], charBudget = 2500): string {
  const crucial = (db
    .prepare("SELECT * FROM memories WHERE rank IN ('critical','high') ORDER BY weight DESC LIMIT 12")
    .all() as any[]).map(rowToFact)
  const medium = (db
    .prepare("SELECT * FROM memories WHERE rank = 'medium' ORDER BY weight DESC LIMIT 5")
    .all() as any[]).map(rowToFact)
  const lines: string[] = ["## hw-memory — persistent project memory (top facts)"]
  if (crucial.length === 0 && medium.length === 0) {
    lines.push(
      "Memory DB is empty. If this project has docs/, suggest the user run hw_memory_seed (dry-run report first, then apply=true).",
    )
  }
  let used = lines.join("\n").length
  const push = (f: FactRow) => {
    const line = `- [${f.rank}/${f.kind}] ${f.content}${f.origin ? ` (src: ${f.origin})` : ""}`
    if (used + line.length > charBudget) return false
    lines.push(line)
    used += line.length
    return true
  }
  for (const f of [...crucial, ...medium]) {
    if (!push(f)) break
  }
  if (docsFooter.length > 0) {
    lines.push("", "## Authoritative docs (source of truth)", ...docsFooter.map((d) => `- ${d}`))
  }
  lines.push("", "Use hw_memory_search tool to recall more.")
  return lines.join("\n")
}

export function updateOrigin(db: DB, id: number, origin: string): void {
  db.prepare("UPDATE memories SET origin = ? WHERE id = ?").run(origin, id)
}

export function setRank(db: DB, id: number, rank: Rank): void {
  const weight = RANK_TABLE[rank].init
  db.prepare("UPDATE memories SET rank = ?, weight = ?, last_verified_at = ? WHERE id = ?").run(rank, weight, nowISO(), id)
}
