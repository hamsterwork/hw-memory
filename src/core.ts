import type { DB } from "./db.ts"
import { DEFAULT_CAP_ROWS, ensureFileTargets, getCapRows } from "./config.ts"
import { contentHash, daysSince, ftsQuery, nowISO, similarityScore, STOPWORDS, tokenSet, tokenize } from "./util.ts"

export type Rank = "critical" | "high" | "medium" | "low"
export type Kind =
  | "decision"
  | "gotcha"
  | "debt"
  | "changelog"
  | "reminder"
  | "error"
  | "dependency"
  | "fact"
export type Source = "auto" | "agent" | "seed"

export const BASE_RATE = 0.008
export const PRUNE_WEIGHT = 0.2
export const CAP_ROWS = DEFAULT_CAP_ROWS

export const RANK_TABLE: Record<Rank, { init: number; rate: number; prunable: boolean }> = {
  critical: { init: 1.0, rate: 0, prunable: false },
  high: { init: 1.0, rate: BASE_RATE * 0.5, prunable: false },
  medium: { init: 1.0, rate: BASE_RATE, prunable: true },
  low: { init: 0.6, rate: BASE_RATE * 2, prunable: true },
}

export const RANK_ORDER: Record<Rank, number> = { critical: 3, high: 2, medium: 1, low: 0 }

/**
 * Words that describe the *category* of an open item rather than its subject, so
 * they never create task relevance on their own.
 */
const GENERIC_TASK_TOKENS = new Set([
  "debt", "debts", "reminder", "reminders", "remind", "technical", "todo", "task", "tasks",
  "memory", "memories", "agent", "project", "issue", "issues", "problem", "problems",
  "need", "needs", "want", "wants", "make", "let", "check", "checks", "work", "works",
  "долг", "долги", "напоминание", "напоминания", "задача", "задачи",
])

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
  scope: string | null
  obsolete_at: string | null
  last_verified_at: string | null
  /** Last disposition check (see `verifyFact`). Reporting only — it never resets decay. */
  last_checked_at: string | null
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
  scope?: string
  verified?: string
  exact?: boolean
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
  return (
    kind === "decision" ||
    kind === "gotcha" ||
    kind === "debt" ||
    kind === "changelog" ||
    kind === "reminder" ||
    rank === "critical" ||
    rank === "high"
  )
}

/** Kinds that are never removed by decay, pruning or the row cap. */
export function isNeverPrunedKind(kind: Kind): boolean {
  return kind === "debt" || kind === "reminder" || kind === "changelog"
}

/** Obsolete high/critical decisions and gotchas lose their prune protection. */
export function isProtectedFromPrune(fact: Pick<FactRow, "kind" | "rank" | "obsolete_at">): boolean {
  if (isNeverPrunedKind(fact.kind)) return true
  if (fact.rank === "critical") return true
  if (fact.rank !== "high") return false
  return !(fact.obsolete_at && (fact.kind === "decision" || fact.kind === "gotcha"))
}

export function clampDebtRank(rank?: Rank): Rank {
  if (rank === "critical" || rank === "high") return rank
  return "medium"
}

export function promoteRank(rank: Rank, accesses: number): Rank {
  if (rank === "low" && accesses >= 4) return "medium"
  if (rank === "medium" && accesses >= 8) return "high"
  return rank
}

function normalizeSeedOrigins(db: DB): void {
  const dups = db
    .prepare(
      "SELECT origin FROM memories WHERE source = 'seed' AND origin IS NOT NULL GROUP BY origin HAVING COUNT(*) > 1",
    )
    .all() as any[]
  for (const d of dups) {
    const rows = db
      .prepare("SELECT id, rank, accesses FROM memories WHERE source = 'seed' AND origin = ? ORDER BY id ASC")
      .all(d.origin) as any[]
    let survivor = rows[0]
    for (const r of rows) {
      const better =
        RANK_ORDER[r.rank as Rank] > RANK_ORDER[survivor.rank as Rank] ||
        (RANK_ORDER[r.rank as Rank] === RANK_ORDER[survivor.rank as Rank] && r.accesses > survivor.accesses)
      if (better) survivor = r
    }
    const totalAccesses = rows.reduce((sum, r) => sum + (r.accesses as number), 0)
    db.prepare("UPDATE memories SET accesses = ? WHERE id = ?").run(totalAccesses, survivor.id)
    for (const r of rows) {
      if (r.id !== survivor.id) db.prepare("DELETE FROM memories WHERE id = ?").run(r.id)
    }
  }
}

function ensureColumn(db: DB, table: string, name: string, sql: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  if (!cols.some((c) => c.name === name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${sql}`)
}

export const SCHEMA_VERSION = 2

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
      last_checked_at TEXT DEFAULT NULL,
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
    CREATE TABLE IF NOT EXISTS file_targets (
      kind TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 0,
      path TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS seed_scopes (
      path TEXT PRIMARY KEY,
      kind TEXT NOT NULL DEFAULT 'file',
      last_seen_hash TEXT NOT NULL DEFAULT '',
      last_seeded_hash TEXT NOT NULL DEFAULT '',
      size INTEGER NOT NULL DEFAULT 0,
      mtime_ms INTEGER NOT NULL DEFAULT 0,
      files INTEGER NOT NULL DEFAULT 0,
      skipped INTEGER NOT NULL DEFAULT 0,
      last_seeded_at TEXT DEFAULT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS doc_manifest (
      fact_id INTEGER PRIMARY KEY,
      file TEXT NOT NULL,
      heading TEXT NOT NULL DEFAULT '',
      line_hash TEXT NOT NULL,
      owner TEXT NOT NULL DEFAULT 'plugin',
      origin TEXT DEFAULT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS change_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      session_id TEXT DEFAULT NULL,
      source TEXT NOT NULL,
      summary TEXT NOT NULL,
      ref TEXT DEFAULT NULL
    );
    CREATE TABLE IF NOT EXISTS version_checkpoints (
      label TEXT PRIMARY KEY,
      commit_sha TEXT DEFAULT NULL,
      journal_seq INTEGER DEFAULT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pending_doc_updates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fact_id INTEGER NOT NULL,
      file TEXT NOT NULL,
      heading TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'proposed',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pending_prunes (
      fact_id INTEGER PRIMARY KEY,
      kind TEXT NOT NULL,
      rank TEXT NOT NULL,
      content TEXT NOT NULL,
      weight REAL NOT NULL,
      created_at TEXT NOT NULL
    );
  `)

  ensureColumn(db, "memories", "scope", "scope TEXT DEFAULT NULL")
  ensureColumn(db, "memories", "obsolete_at", "obsolete_at TEXT DEFAULT NULL")
  ensureColumn(db, "memories", "last_checked_at", "last_checked_at TEXT DEFAULT NULL")
  ensureColumn(db, "seed_scopes", "line_hashes", "line_hashes TEXT NOT NULL DEFAULT ''")
  ensureFileTargets(db)
  normalizeSeedOrigins(db)
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_memories_seed_origin
       ON memories(origin) WHERE source = 'seed' AND origin IS NOT NULL;`,
  )
  db.prepare(
    `UPDATE memories SET scope = CASE WHEN instr(origin, '#') > 0
       THEN substr(origin, 1, instr(origin, '#') - 1) ELSE origin END
     WHERE source = 'seed' AND origin IS NOT NULL AND scope IS NULL`,
  ).run()
  const version = (db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined)?.user_version ?? 0
  if (version < SCHEMA_VERSION) db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
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
    scope: (r.scope ?? null) as string | null,
    obsolete_at: (r.obsolete_at ?? null) as string | null,
    last_verified_at: (r.last_verified_at ?? null) as string | null,
    last_checked_at: (r.last_checked_at ?? null) as string | null,
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

export function findSimilar(db: DB, content: string, kind: Kind, exactOnly = false): FactRow | null {
  const hash = contentHash(content)
  const exact = db.prepare("SELECT * FROM memories WHERE content_hash = ?").get(hash)
  if (exact) return rowToFact(exact)
  if (exactOnly) return null
  const target = tokenSet(content)
  if (target.size === 0) return null
  const rows = db.prepare("SELECT * FROM memories WHERE kind = ?").all(kind) as any[]
  let best: FactRow | null = null
  let bestScore = 0
  for (const r of rows) {
    const score = similarityScore(target, tokenSet(r.content))
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
  const requestedRank = kind === "debt" ? clampDebtRank(input.rank) : input.rank
  const dup = findSimilar(db, content, kind, input.exact ?? false)
  const now = nowISO()
  // Hardening: a tiny stored fragment can never be a superset of a real fact —
  // if the matched row has < 8 tokens and the new content is materially longer,
  // store the new fact instead of absorbing it. Defence in depth behind the
  // comparability gate in similarityScore; see drafts/2026-10-28-dedup-false-positive-short-facts.md.
  const dupTokens = dup ? tokenSet(dup.content).size : 0
  const fragmentGuard = dupTokens > 0 && dupTokens < 8 && tokenSet(content).size >= 2 * dupTokens
  if (dup && !fragmentGuard) {
    const accesses = dup.accesses + 1
    let rank = dup.rank
    if (requestedRank && RANK_ORDER[requestedRank] > RANK_ORDER[rank]) rank = requestedRank
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
  const rank = requestedRank ?? "medium"
  const weight = RANK_TABLE[rank].init
  const info = db
    .prepare(
      `INSERT INTO memories (content, content_hash, keywords, kind, rank, weight, accesses, source, origin, scope, last_verified_at, created_at, last_accessed_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
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
      input.scope ?? null,
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

/** Significant task words: no stopwords, no item-category words, no fragments. */
function taskTokens(text: string): Set<string> {
  const out = new Set<string>()
  for (const t of tokenize(text)) {
    if (t.length < 4 || STOPWORDS.has(t) || GENERIC_TASK_TOKENS.has(t)) continue
    out.add(t)
  }
  return out
}

/**
 * Read-only relevance match: which open items touch this task text. A candidate
 * qualifies only when it shares at least `minShared` significant words, so a
 * passing mention of "debt" never surfaces an unrelated item. Unlike
 * `searchFacts`, this never bumps accesses or weight.
 */
export function findRelatedItems(
  db: DB,
  task: string,
  opts: { kinds?: Kind[]; limit?: number; minShared?: number } = {},
): FactRow[] {
  const want = taskTokens(task)
  const minShared = opts.minShared ?? 2
  if (want.size < minShared) return []
  const kinds = opts.kinds ?? ["debt", "reminder"]
  const rows = (db
    .prepare(
      `SELECT * FROM memories WHERE obsolete_at IS NULL AND kind IN (${kinds.map(() => "?").join(",")})`,
    )
    .all(...kinds) as any[]).map(rowToFact)
  const scored: { fact: FactRow; shared: number }[] = []
  for (const fact of rows) {
    const hay = tokenSet(`${fact.content} ${fact.keywords}`)
    let shared = 0
    for (const t of want) if (hay.has(t)) shared++
    if (shared >= minShared) scored.push({ fact, shared })
  }
  scored.sort((a, b) => b.shared - a.shared || b.fact.weight - a.fact.weight || a.fact.id - b.fact.id)
  return scored.slice(0, opts.limit ?? 3).map((s) => s.fact)
}

export interface MaintainReport {
  decayed: number
  pruned: number
  capped: number
  promoted: number
  proposed: number
  obsoleted: number
  total: number
}

const lastMaintain = new WeakMap<DB, number>()

const emptyMaintain = (db: DB): MaintainReport => ({
  decayed: 0,
  pruned: 0,
  capped: 0,
  promoted: 0,
  proposed: 0,
  obsoleted: 0,
  total: countFacts(db),
})

function proposePrune(db: DB, fact: FactRow, weight: number): boolean {
  const info = db
    .prepare(
      `INSERT OR IGNORE INTO pending_prunes (fact_id, kind, rank, content, weight, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(fact.id, fact.kind, fact.rank, fact.content, weight, nowISO()) as any
  return (info.changes ?? 0) > 0
}

export function maintain(db: DB, force = false): MaintainReport {
  const now = Date.now()
  if (!force && lastMaintain.has(db) && now - (lastMaintain.get(db) as number) < 3_600_000) return emptyMaintain(db)
  lastMaintain.set(db, now)
  const report: MaintainReport = {
    decayed: 0,
    pruned: 0,
    capped: 0,
    promoted: 0,
    proposed: 0,
    obsoleted: 0,
    total: 0,
  }
  const rows = db.prepare("SELECT * FROM memories").all() as any[]
  const updates: { id: number; rank: Rank; weight: number }[] = []
  const pruneIds: number[] = []
  for (const r of rows) {
    const fact = rowToFact(r)
    let rank = promoteRank(fact.rank, fact.accesses)
    if (fact.obsolete_at && (fact.kind === "decision" || fact.kind === "gotcha") && fact.rank !== "low") {
      rank = "low"
      report.obsoleted++
    }
    const weight = computeWeight(rank, fact.accesses, effectiveAgeDays(fact))
    if (rank !== fact.rank) report.promoted++
    const protectedFact = isProtectedFromPrune({ ...fact, rank })
    if (!protectedFact && weight < PRUNE_WEIGHT && !isNeverPrunedKind(fact.kind)) {
      if (rank === "medium" && (fact.kind === "decision" || fact.kind === "gotcha")) {
        if (proposePrune(db, fact, weight)) report.proposed++
        continue
      }
      pruneIds.push(fact.id)
      continue
    }
    if (Math.abs(weight - fact.weight) > 0.0001 || rank !== fact.rank) {
      updates.push({ id: fact.id, rank, weight })
    }
  }
  for (const u of updates) {
    db.prepare("UPDATE memories SET weight = ?, rank = ? WHERE id = ?").run(u.weight, u.rank, u.id)
  }
  report.decayed = updates.length
  for (const id of pruneIds) {
    db.prepare("DELETE FROM memories WHERE id = ?").run(id)
    db.prepare("DELETE FROM pending_prunes WHERE fact_id = ?").run(id)
  }
  report.pruned = pruneIds.length

  const cap = getCapRows(db)
  let total = countFacts(db)
  if (total > cap) {
    const remaining = (db.prepare("SELECT * FROM memories").all() as any[])
      .map(rowToFact)
      .filter((f) => !isNeverPrunedKind(f.kind) && !isProtectedFromPrune(f))
      .filter((f) => !(f.rank === "medium" && (f.kind === "decision" || f.kind === "gotcha")))
      .sort((a, b) => a.weight - b.weight || a.accesses - b.accesses)
      .slice(0, total - cap)
    for (const f of remaining) {
      db.prepare("DELETE FROM memories WHERE id = ?").run(f.id)
      db.prepare("DELETE FROM pending_prunes WHERE fact_id = ?").run(f.id)
    }
    report.capped = remaining.length
    total = countFacts(db)
  }
  report.total = total
  return report
}

export function forgetFact(db: DB, id: number): boolean {
  const res = db.prepare("DELETE FROM memories WHERE id = ?").run(id) as any
  if ((res.changes ?? 0) > 0) {
    db.prepare("DELETE FROM pending_prunes WHERE fact_id = ?").run(id)
    db.prepare("DELETE FROM pending_doc_updates WHERE fact_id = ?").run(id)
    db.prepare("DELETE FROM doc_manifest WHERE fact_id = ?").run(id)
  }
  return (res.changes ?? 0) > 0
}

export function listFactsByKind(db: DB, kind: Kind): FactRow[] {
  return (db
    .prepare("SELECT * FROM memories WHERE kind = ? ORDER BY weight DESC, created_at DESC")
    .all(kind) as any[]).map(rowToFact)
}

/** Open reminders only: resolved ones stay as tombstones for `/hw-docs` line removal. */
export function listReminders(db: DB): FactRow[] {
  return (db
    .prepare("SELECT * FROM memories WHERE kind = 'reminder' AND obsolete_at IS NULL ORDER BY weight DESC, created_at DESC")
    .all() as any[]).map(rowToFact)
}

export function listChangelog(db: DB): FactRow[] {
  return listFactsByKind(db, "changelog")
}

export function markObsolete(db: DB, id: number): boolean {
  const res = db
    .prepare("UPDATE memories SET obsolete_at = ? WHERE id = ? AND obsolete_at IS NULL")
    .run(nowISO(), id) as any
  return (res.changes ?? 0) > 0
}

export interface PendingPruneRow {
  fact_id: number
  kind: Kind
  rank: Rank
  content: string
  weight: number
  created_at: string
}

export function listPendingPrunes(db: DB): PendingPruneRow[] {
  return (db.prepare("SELECT * FROM pending_prunes ORDER BY weight ASC, created_at ASC").all() as any[]).map((r) => ({
    fact_id: r.fact_id as number,
    kind: r.kind as Kind,
    rank: r.rank as Rank,
    content: r.content as string,
    weight: r.weight as number,
    created_at: r.created_at as string,
  }))
}

export function resolvePrune(db: DB, id: number, approved: boolean): boolean {
  const row = db.prepare("SELECT fact_id FROM pending_prunes WHERE fact_id = ?").get(id) as any
  if (!row) return false
  if (approved) forgetFact(db, id)
  else db.prepare("DELETE FROM pending_prunes WHERE fact_id = ?").run(id)
  return true
}

export function forgetKind(db: DB, kind: Kind): number {
  const res = db.prepare("DELETE FROM memories WHERE kind = ? AND rank NOT IN ('critical','high')").run(kind) as any
  return res.changes ?? 0
}

export function listDebt(db: DB): FactRow[] {
  return (db
    .prepare("SELECT * FROM memories WHERE kind = 'debt' AND obsolete_at IS NULL ORDER BY weight DESC, created_at DESC")
    .all() as any[]).map(rowToFact)
}

export function countDebt(db: DB): number {
  return (db.prepare("SELECT COUNT(*) AS c FROM memories WHERE kind = 'debt' AND obsolete_at IS NULL").get() as any)
    .c as number
}

export function countReminders(db: DB): number {
  return (db.prepare("SELECT COUNT(*) AS c FROM memories WHERE kind = 'reminder' AND obsolete_at IS NULL").get() as any)
    .c as number
}

/** Every open item that needs a decision: debt plus reminders. */
export function countOpenItems(db: DB): number {
  return (
    db
      .prepare("SELECT COUNT(*) AS c FROM memories WHERE kind IN ('debt','reminder') AND obsolete_at IS NULL")
      .get() as any
  ).c as number
}

/**
 * Open debt/reminder rows that need a disposition check, oldest first.
 * `staleDays` 0 returns anything not checked today; a positive value only
 * returns items whose last check (or creation) is at least that old.
 */
export function listStaleOpenItems(db: DB, opts: { staleDays?: number; limit?: number } = {}): FactRow[] {
  const staleDays = opts.staleDays ?? 0
  const rows = (db
    .prepare(
      `SELECT * FROM memories WHERE kind IN ('debt','reminder') AND obsolete_at IS NULL
       ORDER BY created_at ASC, id ASC`,
    )
    .all() as any[]).map(rowToFact)
  const due = rows.filter((f) => {
    if (staleDays <= 0) return !f.last_checked_at || daysSince(f.last_checked_at) >= 1
    return daysSince(f.last_checked_at ?? f.created_at) >= staleDays
  })
  return due.slice(0, opts.limit ?? 10)
}

/** Human age for an open item: staleness must be visible, not something to infer. */
export function factAgeLabel(fact: Pick<FactRow, "created_at" | "last_verified_at" | "last_checked_at">): string {
  const open = Math.max(0, Math.floor(daysSince(fact.created_at)))
  const checked = fact.last_checked_at ?? fact.last_verified_at
  if (!checked) return `open ${open}d, never checked`
  return `open ${open}d, checked ${Math.max(0, Math.floor(daysSince(checked)))}d ago`
}

/** Mark any open item resolved without deleting it: lists drop it and its doc line is removed on /hw-docs --apply. */
export function resolveFact(db: DB, id: number): FactRow | null {
  const fact = getFact(db, id)
  if (!fact || fact.obsolete_at) return null
  if (fact.kind !== "debt" && fact.kind !== "reminder") return null
  markObsolete(db, id)
  return getFact(db, id)
}

/**
 * Record that an open item was looked at and is still open. Writes
 * `last_checked_at` only: weight and the decay clock are untouched, so
 * re-verifying an item cannot keep it alive forever.
 */
export function verifyFact(db: DB, id: number): FactRow | null {
  const fact = getFact(db, id)
  if (!fact || fact.obsolete_at) return null
  if (fact.kind !== "debt" && fact.kind !== "reminder") return null
  db.prepare("UPDATE memories SET last_checked_at = ? WHERE id = ?").run(nowISO(), id)
  return getFact(db, id)
}

/**
 * Mark a debt resolved without deleting it: it stops appearing in debt lists,
 * and its exact plugin-written doc line is removed on the next `/hw-docs --apply`.
 */
export function resolveDebt(db: DB, id: number): FactRow | null {
  const fact = getFact(db, id)
  if (!fact || fact.kind !== "debt" || fact.obsolete_at) return null
  markObsolete(db, id)
  return getFact(db, id)
}

export interface StatsReport {
  total: number
  byRank: Record<string, number>
  byKind: Record<string, number>
  bySource: Record<string, number>
  avgWeight: number
  oldest: string | null
  debt: number
  reminders: number
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
    debt: countDebt(db),
    reminders: countReminders(db),
  }
}

function factLine(f: FactRow, withId = false): string {
  return `- ${withId ? `#${f.id} ` : ""}[${f.rank}/${f.kind}] ${f.content}${f.origin ? ` (src: ${f.origin})` : ""}`
}

/**
 * The system text injected every turn. Open items are shown with their id and
 * age, a task-relevant subset is surfaced separately, and truncation is stated
 * instead of silent so an item outside the slice is never invisible.
 */
export function wakeUpPack(db: DB, charBudget = 2500, task = ""): string {
  const crucial = (db
    .prepare("SELECT * FROM memories WHERE rank IN ('critical','high') ORDER BY weight DESC LIMIT 12")
    .all() as any[]).map(rowToFact)
  const medium = (db
    .prepare("SELECT * FROM memories WHERE rank = 'medium' ORDER BY weight DESC LIMIT 5")
    .all() as any[]).map(rowToFact)
  const debtRows = listDebt(db)
  const reminderRows = listReminders(db)
  const related = task.trim() ? findRelatedItems(db, task, { limit: 3 }) : []
  const relatedIds = new Set(related.map((f) => f.id))
  const lines: string[] = ["## hw-memory — persistent project memory (top facts)"]
  if (crucial.length === 0 && medium.length === 0 && debtRows.length === 0 && reminderRows.length === 0) {
    lines.push("Memory DB is empty. Suggest the user run /hw-seed <path> to import notes or docs.")
  }
  let used = lines.join("\n").length
  const push = (line: string): boolean => {
    if (used + line.length + 1 > charBudget) return false
    lines.push(line)
    used += line.length + 1
    return true
  }
  for (const f of [...crucial, ...medium]) {
    if (!push(factLine(f))) break
  }
  const section = (title: string, rows: FactRow[], total: number, more: string): void => {
    if (rows.length === 0) return
    if (used + title.length + 2 > charBudget) return
    push("")
    push(title)
    let shown = 0
    for (const f of rows) {
      if (!push(factLine(f, true))) break
      shown++
    }
    if (shown < total) push(`- …and ${total - shown} more (${more})`)
  }
  section(
    "## Possibly related to this task — verify or resolve when done",
    related,
    related.length,
    "see the open-item lists",
  )
  const openDebt = debtRows.filter((f) => !relatedIds.has(f.id))
  const openReminders = reminderRows.filter((f) => !relatedIds.has(f.id))
  section(
    `## Open technical debt (${debtRows.length}) — tell the user about new items before finishing`,
    openDebt.slice(0, 5),
    openDebt.length,
    "see /hw-debts",
  )
  section(
    `## Open reminders (${reminderRows.length}) — resolve when done`,
    openReminders.slice(0, 5),
    openReminders.length,
    "see /hw-reminders",
  )
  push("")
  push("Use hw_memory_search tool to recall more.")
  return lines.join("\n")
}

export function updateOrigin(db: DB, id: number, origin: string): void {
  db.prepare("UPDATE memories SET origin = ? WHERE id = ?").run(origin, id)
}

export function setRank(db: DB, id: number, rank: Rank): void {
  const weight = RANK_TABLE[rank].init
  db.prepare("UPDATE memories SET rank = ?, weight = ?, last_verified_at = ? WHERE id = ?").run(rank, weight, nowISO(), id)
}
