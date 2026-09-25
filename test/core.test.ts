import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { DB } from "../src/db.ts"
import { openDBFile } from "../src/db.ts"
import {
  addFact,
  computeWeight,
  countFacts,
  findSimilar,
  forgetFact,
  forgetKind,
  getFact,
  initSchema,
  isCrucial,
  maintain,
  promoteRank,
  searchFacts,
  setRank,
  statsFacts,
  wakeUpPack,
} from "../src/core.ts"

let db: DB
let dir: string

test.before(async () => {
  dir = mkdtempSync(join(tmpdir(), "hwm-core-"))
  db = await openDBFile(join(dir, "hw-memory.db"))
  initSchema(db)
})

test.after(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

test("schema is idempotent", () => {
  initSchema(db)
  assert.equal(countFacts(db), 0)
})

test("insert and read fact", () => {
  const res = addFact(db, {
    content: "Use PostgreSQL for the main DB",
    keywords: ["postgres", "database"],
    kind: "decision",
    rank: "critical",
    source: "agent",
  })
  assert.equal(res.status, "inserted")
  assert.equal(res.crucial, true)
  const fact = getFact(db, res.id)
  assert.ok(fact)
  assert.equal(fact.kind, "decision")
  assert.equal(fact.rank, "critical")
  assert.equal(fact.weight, 1.0)
  assert.equal(fact.keywords, "postgres,database")
})

test("exact hash dedup updates instead of inserting", () => {
  const first = addFact(db, { content: "Run tests with npm run verify", kind: "fact", rank: "medium" })
  const second = addFact(db, { content: "run  tests   with npm run verify", kind: "fact", rank: "medium" })
  assert.equal(second.status, "updated")
  assert.equal(second.id, first.id)
  assert.equal(countFacts(db) > 0, true)
  const fact = getFact(db, first.id)
  assert.ok(fact)
  assert.equal(fact.accesses, 1)
})

test("jaccard near-dedup within same kind", () => {
  const a = addFact(db, { content: "The parser uses a Pratt algorithm for expressions", kind: "fact", rank: "low" })
  const b = addFact(db, { content: "The parser uses a Pratt algorithm", kind: "fact", rank: "low" })
  assert.equal(b.status, "updated")
  assert.equal(b.id, a.id)
  const different = addFact(db, { content: "Sass tokens are defined as CSS custom properties", kind: "fact", rank: "low" })
  assert.equal(different.status, "inserted")
})

test("findSimilar returns null on no match", () => {
  assert.equal(findSimilar(db, "completely unrelated topic about birds", "decision"), null)
})

test("search ranks and bumps accesses", () => {
  addFact(db, { content: "auth strategy uses JWT tokens with refresh rotation", keywords: ["auth", "jwt"], kind: "fact", rank: "medium" })
  addFact(db, { content: "deploy pipeline copies dist folder to dev server", keywords: ["deploy", "pipeline"], kind: "fact", rank: "medium" })
  const hits = searchFacts(db, "auth jwt tokens", { limit: 5 })
  assert.ok(hits.length >= 1)
  assert.ok(hits[0].content.includes("auth"))
  const fact = getFact(db, hits[0].id)
  assert.ok(fact)
  assert.equal(fact.accesses, 1)
  assert.ok(fact.weight > 0)
})

test("search sanitizes FTS operators", () => {
  const hits = searchFacts(db, 'auth "OR" AND (jwt) *', { limit: 5 })
  assert.ok(Array.isArray(hits))
})

test("search kind filter", () => {
  addFact(db, { content: "postgres migration failed with timeout", kind: "error", rank: "low" })
  const onlyErrors = searchFacts(db, "postgres migration", { kinds: ["error"] })
  assert.ok(onlyErrors.every((f) => f.kind === "error"))
})

test("decay math: critical never decays, low decays fastest", () => {
  assert.equal(computeWeight("critical", 0, 365), 1.0)
  const high = computeWeight("high", 0, 100)
  const medium = computeWeight("medium", 0, 100)
  const low = computeWeight("low", 0, 100)
  assert.ok(high > medium)
  assert.ok(medium > low)
  assert.ok(low < 0.6)
  const accessed = computeWeight("medium", 20, 100)
  assert.ok(accessed > medium)
})

test("promoteRank thresholds", () => {
  assert.equal(promoteRank("low", 3), "low")
  assert.equal(promoteRank("low", 4), "medium")
  assert.equal(promoteRank("medium", 7), "medium")
  assert.equal(promoteRank("medium", 8), "high")
  assert.equal(promoteRank("high", 100), "high")
})

test("maintain prunes decayed low-rank facts and never prunes high", async () => {
  const dir2 = mkdtempSync(join(tmpdir(), "hwm-maint-"))
  const db2 = await openDBFile(join(dir2, "hw-memory.db"))
  initSchema(db2)
  const old = "2020-01-01T00:00:00.000Z"
  db2.prepare(
    `INSERT INTO memories (content, content_hash, keywords, kind, rank, weight, accesses, source, origin, last_verified_at, created_at, last_accessed_at)
     VALUES (?, ?, '', 'fact', ?, ?, 0, 'auto', NULL, NULL, ?, NULL)`,
  ).run("stale ephemeral observation number one", "hash-a1", "low", 0.6, old)
  db2.prepare(
    `INSERT INTO memories (content, content_hash, keywords, kind, rank, weight, accesses, source, origin, last_verified_at, created_at, last_accessed_at)
     VALUES (?, ?, '', 'fact', ?, ?, 0, 'auto', NULL, NULL, ?, NULL)`,
  ).run("stale ephemeral observation number two", "hash-a2", "low", 0.6, old)
  db2.prepare(
    `INSERT INTO memories (content, content_hash, keywords, kind, rank, weight, accesses, source, origin, last_verified_at, created_at, last_accessed_at)
     VALUES (?, ?, '', 'decision', ?, ?, 0, 'auto', NULL, NULL, ?, NULL)`,
  ).run("old but critical decision about database", "hash-a3", "critical", 1.0, old)
  const report = maintain(db2, true)
  assert.equal(report.pruned, 2)
  assert.equal(report.total, 1)
  const survivor = (db2.prepare("SELECT content FROM memories").all() as any[])[0]
  assert.equal(survivor.content, "old but critical decision about database")
  db2.close()
  rmSync(dir2, { recursive: true, force: true })
})

test("maintain throttles to once per hour", () => {
  maintain(db, true)
  const second = maintain(db, false)
  assert.equal(second.decayed, 0)
})

test("maintain cap enforcement keeps crucial rows", async () => {
  const dir3 = mkdtempSync(join(tmpdir(), "hwm-cap-"))
  const db3 = await openDBFile(join(dir3, "hw-memory.db"))
  initSchema(db3)
  const insert = db3.prepare(
    `INSERT INTO memories (content, content_hash, keywords, kind, rank, weight, accesses, source, origin, last_verified_at, created_at, last_accessed_at)
     VALUES (?, ?, '', 'fact', 'medium', 1.0, 0, 'auto', NULL, NULL, ?, NULL)`,
  )
  for (let i = 0; i < 510; i++) {
    insert.run(`filler fact number ${i} about topic ${i % 7}`, `hash-f${i}`, new Date().toISOString())
  }
  insert.run("crucial keeper decision", "hash-keep", new Date().toISOString())
  db3.prepare("UPDATE memories SET kind = 'decision', rank = 'critical' WHERE content_hash = 'hash-keep'").run()
  const report = maintain(db3, true)
  assert.ok(report.capped >= 10)
  assert.equal(report.total, 500)
  const keeper = findSimilar(db3, "crucial keeper decision", "decision")
  assert.ok(keeper)
  db3.close()
  rmSync(dir3, { recursive: true, force: true })
})

test("forget removes fact", () => {
  const res = addFact(db, { content: "temporary note to be forgotten soon", kind: "fact", rank: "low" })
  assert.equal(forgetFact(db, res.id), true)
  assert.equal(forgetFact(db, res.id), false)
  assert.equal(getFact(db, res.id), null)
})

test("forgetKind spares crucial ranks", () => {
  addFact(db, { content: "low rank decision candidate to drop", kind: "decision", rank: "low" })
  addFact(db, { content: "pinned high decision that must survive purge", kind: "decision", rank: "high" })
  const removed = forgetKind(db, "decision")
  assert.equal(removed, 1)
  assert.equal(findSimilar(db, "pinned high decision that must survive purge", "decision") !== null, true)
})

test("setRank re-weights and verifies", () => {
  const res = addFact(db, { content: "fact whose rank will be escalated manually", kind: "fact", rank: "low" })
  setRank(db, res.id, "critical")
  const fact = getFact(db, res.id)
  assert.ok(fact)
  assert.equal(fact.rank, "critical")
  assert.equal(fact.weight, 1.0)
  assert.ok(fact.last_verified_at)
})

test("stats and wake-up pack render", () => {
  const stats = statsFacts(db)
  assert.ok(stats.total > 0)
  assert.ok(stats.byRank)
  const pack = wakeUpPack(db, ["docs/decisions.md", "docs/gotchas.md"])
  assert.ok(pack.includes("## hw-memory"))
  assert.ok(pack.includes("Authoritative docs"))
  assert.ok(pack.includes("hw_memory_search"))
  assert.ok(pack.length < 3000)
})

test("isCrucial semantics", () => {
  assert.equal(isCrucial("decision", "medium"), true)
  assert.equal(isCrucial("gotcha", "medium"), true)
  assert.equal(isCrucial("dependency", "high"), true)
  assert.equal(isCrucial("fact", "low"), false)
})

test("wakeUpPack suggests seeding when memory is empty", async () => {
  const dirE = mkdtempSync(join(tmpdir(), "hwm-empty-"))
  const dbE = await openDBFile(join(dirE, "hw-memory.db"))
  initSchema(dbE)
  const pack = wakeUpPack(dbE, [])
  assert.ok(pack.includes("Memory DB is empty"))
  assert.ok(pack.includes("hw_memory_seed"))
  dbE.close()
  rmSync(dirE, { recursive: true, force: true })
})
