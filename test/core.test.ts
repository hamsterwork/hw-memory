import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { DB } from "../src/db.ts"
import { openDBFile } from "../src/db.ts"
import { setCapRows } from "../src/config.ts"
import {
  addFact,
  clampDebtRank,
  computeWeight,
  countDebt,
  countFacts,
  countReminders,
  factAgeLabel,
  findRelatedItems,
  findSimilar,
  forgetFact,
  forgetKind,
  getFact,
  initSchema,
  isCrucial,
  isNeverPrunedKind,
  isProtectedFromPrune,
  listDebt,
  listPendingPrunes,
  listReminders,
  listStaleOpenItems,
  maintain,
  markObsolete,
  promoteRank,
  resolveDebt,
  resolveFact,
  resolvePrune,
  searchFacts,
  setRank,
  statsFacts,
  verifyFact,
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

test("maintain honours the configured cap_rows", async () => {
  const dir4 = mkdtempSync(join(tmpdir(), "hwm-cap-config-"))
  const db4 = await openDBFile(join(dir4, "hw-memory.db"))
  initSchema(db4)
  setCapRows(db4, 50)
  const insert = db4.prepare(
    `INSERT INTO memories (content, content_hash, keywords, kind, rank, weight, accesses, source, origin, last_verified_at, created_at, last_accessed_at)
     VALUES (?, ?, '', ?, ?, 1.0, 0, 'auto', NULL, NULL, ?, NULL)`,
  )
  const now = new Date().toISOString()
  for (let i = 0; i < 52; i++) insert.run(`filler medium fact ${i}`, `hash-c${i}`, "fact", "medium", now)
  insert.run("protected critical decision", "hash-crit", "decision", "critical", now)
  insert.run("protected debt item", "hash-debt", "debt", "medium", now)
  const report = maintain(db4, true)
  assert.equal(report.capped, 4)
  assert.equal(report.total, 50, "cap_rows keeps at most fifty facts")
  const rows = db4.prepare("SELECT content FROM memories").all() as any[]
  const contents = rows.map((r) => r.content)
  assert.ok(contents.includes("protected critical decision"))
  assert.ok(contents.includes("protected debt item"))
  db4.close()
  rmSync(dir4, { recursive: true, force: true })
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
  const pack = wakeUpPack(db)
  assert.ok(pack.includes("## hw-memory"))
  assert.ok(pack.includes("hw_memory_search"))
  assert.ok(!pack.includes("Authoritative docs"))
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
  const pack = wakeUpPack(dbE)
  assert.ok(pack.includes("Memory DB is empty"))
  assert.ok(pack.includes("/hw-seed"))
  dbE.close()
  rmSync(dirE, { recursive: true, force: true })
})

test("debt rank clamps low to medium and keeps high/critical", () => {
  assert.equal(clampDebtRank(undefined), "medium")
  assert.equal(clampDebtRank("low"), "medium")
  assert.equal(clampDebtRank("medium"), "medium")
  assert.equal(clampDebtRank("high"), "high")
  assert.equal(clampDebtRank("critical"), "critical")
  const low = addFact(db, { content: "low severity debt should be clamped upward", kind: "debt", rank: "low" })
  assert.equal(low.rank, "medium")
  const crit = addFact(db, { content: "critical severity debt stays critical for retention", kind: "debt", rank: "critical" })
  assert.equal(crit.rank, "critical")
})

test("debt is listed, counted and resolved by obsolescence", () => {
  const res = addFact(db, { content: "mismatch between API contract and serializers", kind: "debt", rank: "high" })
  const before = countDebt(db)
  assert.ok(before >= 1)
  assert.ok(listDebt(db).some((d) => d.id === res.id))
  const resolved = resolveDebt(db, res.id)
  assert.ok(resolved)
  assert.ok(resolved.obsolete_at)
  assert.equal(countDebt(db), before - 1, "resolved debt leaves the open-debt count")
  assert.ok(!listDebt(db).some((d) => d.id === res.id))
  assert.equal(resolveDebt(db, res.id), null, "resolving twice is a no-op")
  assert.ok(getFact(db, res.id), "resolving keeps a tombstone so /hw-docs can remove its exact line")
})

test("maintain never prunes or caps debt regardless of rank", async () => {
  const dirD = mkdtempSync(join(tmpdir(), "hwm-debt-"))
  const dbD = await openDBFile(join(dirD, "hw-memory.db"))
  initSchema(dbD)
  const old = "2020-01-01T00:00:00.000Z"
  dbD.prepare(
    `INSERT INTO memories (content, content_hash, keywords, kind, rank, weight, accesses, source, origin, last_verified_at, created_at, last_accessed_at)
     VALUES (?, ?, '', 'debt', 'medium', 0.01, 0, 'agent', NULL, NULL, ?, NULL)`,
  ).run("ancient unresolved debt that must survive pruning", "hash-debt", old)
  const report = maintain(dbD, true)
  assert.equal(report.pruned, 0)
  assert.equal(countDebt(dbD), 1)
  dbD.close()
  rmSync(dirD, { recursive: true, force: true })
})

test("stats reports open debt and isCrucial covers debt", () => {
  assert.equal(isCrucial("debt", "medium"), true)
  const stats = statsFacts(db)
  assert.equal(typeof stats.debt, "number")
})

async function withTempDB(fn: (db: DB) => Promise<void> | void): Promise<void> {
  const tempDir = mkdtempSync(join(tmpdir(), "hwm-dedup-"))
  const tdb = await openDBFile(join(tempDir, "hw-memory.db"))
  initSchema(tdb)
  try {
    await fn(tdb)
  } finally {
    tdb.close()
    rmSync(tempDir, { recursive: true, force: true })
  }
}

test("short seeded fragment does not swallow a long fact containing its tokens", async () => {
  await withTempDB(async (tdb) => {
    addFact(tdb, {
      content: "schema/client-config.schema.json — the",
      kind: "fact",
      rank: "high",
      source: "seed",
      origin: "README.md#contracts-5",
      exact: true,
    })
    const res = addFact(tdb, {
      content:
        "Client abus joined the client set on 2026-10-28: config/clients/abus.json at schema 1.7 in Fabricator, plus a tracked BUILD-MANIFEST.json in wp-wifly-sites.",
      kind: "fact",
      rank: "high",
    })
    assert.equal(res.status, "inserted")
    assert.equal(countFacts(tdb), 2)
  })
})

test("three-token fragment does not swallow a same-shape sentence", async () => {
  await withTempDB(async (tdb) => {
    addFact(tdb, {
      content: "Visitator (в visitator-core):",
      kind: "fact",
      rank: "high",
      source: "seed",
      origin: "docs/manager-readme.md#4",
      exact: true,
    })
    const res = addFact(tdb, {
      content: "Visitator в visitator-core держит jobs по проверке реального сайта и собирает отчёты.",
      kind: "fact",
      rank: "high",
    })
    assert.equal(res.status, "inserted")
    assert.equal(countFacts(tdb), 2)
  })
})

test("genuine near-duplicate keeps stored content and bumps accesses", async () => {
  await withTempDB(async (tdb) => {
    const first = addFact(tdb, { content: "The parser uses a Pratt algorithm for expressions", kind: "fact", rank: "low" })
    const second = addFact(tdb, {
      content: "The parser uses a Pratt algorithm for expressions, with precedence climbing",
      kind: "fact",
      rank: "low",
    })
    assert.equal(second.status, "updated")
    assert.equal(second.id, first.id)
    const fact = getFact(tdb, first.id)
    assert.ok(fact)
    assert.equal(fact.content, "The parser uses a Pratt algorithm for expressions")
    assert.equal(fact.accesses, 1)
  })
})

test("never-pruned kinds and prune protection classify correctly", () => {
  for (const kind of ["debt", "reminder", "changelog"] as const) assert.equal(isNeverPrunedKind(kind), true)
  for (const kind of ["fact", "decision", "gotcha", "error", "dependency"] as const) {
    assert.equal(isNeverPrunedKind(kind), false)
  }
  assert.equal(isProtectedFromPrune({ kind: "decision", rank: "critical", obsolete_at: "2020-01-01" }), true)
  assert.equal(isProtectedFromPrune({ kind: "decision", rank: "high", obsolete_at: null }), true)
  assert.equal(isProtectedFromPrune({ kind: "decision", rank: "high", obsolete_at: "2020-01-01" }), false)
  assert.equal(isProtectedFromPrune({ kind: "gotcha", rank: "high", obsolete_at: "2020-01-01" }), false)
  assert.equal(isProtectedFromPrune({ kind: "reminder", rank: "low", obsolete_at: "2020-01-01" }), true)
})

test("maintain proposes medium decision prunes and approves through pending_prunes", async () => {
  await withTempDB(async (tdb) => {
    const old = "2020-01-01T00:00:00.000Z"
    tdb.prepare(
      `INSERT INTO memories (content, content_hash, keywords, kind, rank, weight, accesses, source, origin, last_verified_at, created_at, last_accessed_at)
       VALUES (?, ?, '', 'decision', 'medium', 0.01, 0, 'agent', NULL, NULL, ?, NULL)`,
    ).run("decayed medium decision awaiting approval", "hash-md", old)
    const report = maintain(tdb, true)
    assert.equal(report.pruned, 0, "medium decisions are not silently removed")
    assert.equal(report.proposed, 1)
    const pending = listPendingPrunes(tdb)
    assert.equal(pending.length, 1)
    assert.equal(pending[0].kind, "decision")
    assert.equal(getFact(tdb, pending[0].fact_id)?.content, "decayed medium decision awaiting approval")
    assert.equal(resolvePrune(tdb, pending[0].fact_id, false), true)
    assert.equal(getFact(tdb, pending[0].fact_id) !== null, true, "rejection keeps the fact")
    assert.equal(listPendingPrunes(tdb).length, 0)
    assert.equal(resolvePrune(tdb, pending[0].fact_id, true), false, "resolved proposal is gone")
  })
})

test("obsolete high decisions demote to low and are then silently pruned", async () => {
  await withTempDB(async (tdb) => {
    const old = "2020-01-01T00:00:00.000Z"
    tdb.prepare(
      `INSERT INTO memories (content, content_hash, keywords, kind, rank, weight, accesses, source, origin, last_verified_at, created_at, last_accessed_at)
       VALUES (?, ?, '', 'decision', 'high', 0.01, 0, 'agent', NULL, NULL, ?, NULL)`,
    ).run("obsolete high decision that lost its source file", "hash-ob", old)
    const id = (tdb.prepare("SELECT id FROM memories").get() as any).id as number
    assert.equal(markObsolete(tdb, id), true)
    assert.equal(markObsolete(tdb, id), false)
    const report = maintain(tdb, true)
    assert.equal(report.obsoleted, 1)
    assert.equal(report.pruned, 1, "obsolete high is no longer protected")
    assert.equal(getFact(tdb, id), null)
  })
})

test("reminder and changelog facts survive decay and the row cap", async () => {
  await withTempDB(async (tdb) => {
    const old = "2020-01-01T00:00:00.000Z"
    const insert = tdb.prepare(
      `INSERT INTO memories (content, content_hash, keywords, kind, rank, weight, accesses, source, origin, last_verified_at, created_at, last_accessed_at)
       VALUES (?, ?, '', ?, 'low', 0.01, 0, 'agent', NULL, NULL, ?, NULL)`,
    )
    insert.run("old reminder that must survive", "hash-rm", "reminder", old)
    insert.run("old changelog entry that must survive", "hash-cl", "changelog", old)
    insert.run("old ephemeral observation", "hash-ep", "fact", old)
    const report = maintain(tdb, true)
    assert.equal(report.pruned, 1)
    assert.equal(listReminders(tdb).length, 1)
    assert.equal(listReminders(tdb)[0].content, "old reminder that must survive")
    assert.equal((tdb.prepare("SELECT content FROM memories WHERE kind='changelog'").all() as any[])[0].content,
      "old changelog entry that must survive")
  })
})

test("initSchema normalizes legacy duplicate seed origins and enforces the unique index", async () => {
  const origin = "docs/legacy.md#section-1"
  const root = mkdtempSync(join(tmpdir(), "hwm-norm-"))
  const dbx = await openDBFile(join(root, "hw-memory.db"))
  initSchema(dbx)
  dbx.exec("DROP INDEX IF EXISTS ux_memories_seed_origin")
  const insert = (content: string, hash: string, rank: string, accesses: number) =>
    dbx
      .prepare(
        `INSERT INTO memories (content, content_hash, keywords, kind, rank, weight, accesses, source, origin, last_verified_at, created_at, last_accessed_at)
         VALUES (?, ?, '', 'fact', ?, 1.0, ?, 'seed', ?, NULL, '2026-01-01T00:00:00.000Z', NULL)`,
      )
      .run(content, hash, rank, accesses, origin)
  insert("legacy duplicate alpha", "h-alpha", "medium", 1)
  insert("legacy duplicate beta", "h-beta", "high", 3)
  initSchema(dbx)
  const rows = dbx.prepare("SELECT rank, accesses FROM memories WHERE origin = ?").all(origin) as any[]
  assert.equal(rows.length, 1)
  assert.equal(rows[0].rank, "high")
  assert.equal(rows[0].accesses, 4)
  assert.throws(() => insert("another duplicate", "h-gamma", "medium", 0))
  dbx.close()
  rmSync(root, { recursive: true, force: true })
})

test("verify stamps the check date without touching weight or the decay clock", async () => {
  await withTempDB((tdb) => {
    const res = addFact(tdb, {
      content: "stale serializer mismatch in the export path",
      kind: "debt",
      rank: "high",
    })
    const before = getFact(tdb, res.id)!
    assert.equal(before.last_checked_at, null)
    assert.match(factAgeLabel(before), /never checked/)

    const verified = verifyFact(tdb, res.id)!
    assert.ok(verified.last_checked_at)
    assert.equal(verified.last_verified_at, null, "verifying must not re-assert the fact")
    assert.equal(verified.weight, before.weight, "verifying never re-weights")
    assert.match(factAgeLabel(verified), /checked 0d ago/)

    assert.deepEqual(
      listStaleOpenItems(tdb, { staleDays: 0 }).map((f) => f.id),
      [],
      "a check today clears the item from the finish-time queue",
    )
  })
})

test("reminders resolve like debt and leave a tombstone for doc removal", async () => {
  await withTempDB((tdb) => {
    const res = addFact(tdb, { content: "follow up on the flaky markdown export test", kind: "reminder" })
    assert.equal(countReminders(tdb), 1)
    assert.ok(listReminders(tdb).some((f) => f.id === res.id))

    const resolved = resolveFact(tdb, res.id)
    assert.ok(resolved?.obsolete_at)
    assert.equal(countReminders(tdb), 0)
    assert.ok(!listReminders(tdb).some((f) => f.id === res.id), "resolved reminders leave the list")
    assert.ok(getFact(tdb, res.id), "tombstone kept so /hw-docs can remove its exact line")
    assert.equal(resolveFact(tdb, res.id), null, "resolving twice is a no-op")

    const plain = addFact(tdb, { content: "a plain durable fact", kind: "fact" })
    assert.equal(resolveFact(tdb, plain.id), null, "only open items resolve")
    assert.equal(verifyFact(tdb, plain.id), null, "only open items verify")
  })
})

test("task relevance needs two significant shares and never bumps accesses", async () => {
  await withTempDB((tdb) => {
    const hit = addFact(tdb, {
      content: "serializer mismatch between the API contract and the export path",
      kind: "debt",
      rank: "high",
    })
    const miss = addFact(tdb, {
      content: "the CI runner caches node modules too aggressively",
      kind: "debt",
      rank: "high",
    })
    assert.deepEqual(findRelatedItems(tdb, "check the open debt", { limit: 5 }), [], "category words alone never match")

    const related = findRelatedItems(tdb, "fix the serializer mismatch in the export path", { limit: 5 })
    assert.deepEqual(related.map((f) => f.id), [hit.id])
    assert.ok(!related.some((f) => f.id === miss.id))

    const accesses = getFact(tdb, hit.id)!.accesses
    findRelatedItems(tdb, "serializer mismatch again", { limit: 5 })
    assert.equal(getFact(tdb, hit.id)!.accesses, accesses, "relevance lookup is read-only")
  })
})

test("wakeUpPack surfaces a related item once and admits truncation", async () => {
  await withTempDB((tdb) => {
    const subjects = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"]
    for (const s of subjects) {
      addFact(tdb, { content: `background ${s} debt inside the widget subsystem`, kind: "debt", rank: "medium" })
    }
    const related = addFact(tdb, {
      content: "the widget serializer drops trailing separators",
      kind: "debt",
      rank: "low",
    })
    const pack = wakeUpPack(tdb, 2500, "fix the widget serializer separators bug")
    assert.match(pack, /Possibly related to this task/)
    assert.equal(pack.split(`#${related.id} `).length - 1, 1, "a related item is listed exactly once")
    assert.match(pack, /…and \d+ more \(see \/hw-debts\)/, "truncation is stated, not silent")
    assert.ok(pack.length < 3000)
  })
})
