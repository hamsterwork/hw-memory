import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { DB } from "../src/db.ts"
import { openDBFile } from "../src/db.ts"
import { countFacts, getFact, initSchema } from "../src/core.ts"
import {
  applySeed,
  changedSeedScopes,
  DEFAULT_SEED_CAPS,
  planSeed,
  resetSeedScopes,
} from "../src/seed.ts"

const environments: { dir: string; db: DB }[] = []

async function makeEnv(): Promise<{ dir: string; db: DB }> {
  const dir = mkdtempSync(join(tmpdir(), "hwm-seed-"))
  const db = await openDBFile(join(dir, "hw-memory.db"))
  initSchema(db)
  environments.push({ dir, db })
  return { dir, db }
}

function write(dir: string, rel: string, text: string): void {
  const abs = join(dir, rel)
  mkdirSync(join(abs, ".."), { recursive: true })
  writeFileSync(abs, text)
}

function scopeCount(db: DB): number {
  return (db.prepare("SELECT COUNT(*) AS c FROM seed_scopes").get() as any).c as number
}

test.after(() => {
  for (const env of environments) {
    env.db.close()
    rmSync(env.dir, { recursive: true, force: true })
  }
})

test("planSeed is read-only and applySeed inserts seed facts", async () => {
  const { dir, db } = await makeEnv()
  write(
    dir,
    "notes.md",
    `# Notes

- [decision] We will use SQLite for the embedded store.
- The weekly report lives on the shared drive for the whole team.
`,
  )
  const plan = planSeed(db, dir, "notes.md")
  assert.equal(plan.path, "notes.md")
  assert.equal(plan.isDir, false)
  assert.equal(plan.files, 1)
  assert.deepEqual(plan.errors, [])
  assert.equal(plan.blocks.length, 2)
  assert.ok(plan.changes.every((c) => c.status === "inserted"))
  assert.equal(countFacts(db), 0)
  assert.equal(scopeCount(db), 0)

  const applied = applySeed(db, dir, "notes.md")
  assert.equal(countFacts(db), 2)
  assert.equal(scopeCount(db), 1)
  assert.equal(applied.changes.filter((c) => c.status === "inserted").length, 2)
  const row = db.prepare("SELECT * FROM seed_scopes WHERE path = ?").get("notes.md") as any
  assert.equal(row.kind, "file")
  assert.equal(row.files, 1)
  assert.equal(row.last_seen_hash, applied.fileHash)
  assert.equal(row.last_seeded_hash, applied.fileHash)
  assert.ok(JSON.parse(row.line_hashes).length > 0)
})

test("a single file larger than the folder byte cap is still seeded", async () => {
  const { dir, db } = await makeEnv()
  const big = "local cache data ".repeat(70_000)
  write(dir, "big.md", `# Big\n\n- ${big}\n`)
  assert.ok(big.length > DEFAULT_SEED_CAPS.bytes)
  const plan = applySeed(db, dir, "big.md")
  assert.deepEqual(plan.errors, [])
  assert.equal(plan.files, 1)
  assert.equal(plan.blocks.length, 1)
  assert.equal(plan.changes.filter((c) => c.status === "inserted").length, 1)
  assert.equal(countFacts(db), 1)
})

test("folder caps, exclusions and symlinks are reported as skipped", async () => {
  const { dir, db } = await makeEnv()
  mkdirSync(join(dir, "docs", "deep"), { recursive: true })
  mkdirSync(join(dir, "docs", ".git"), { recursive: true })
  write(dir, "docs/a.md", "- [decision] We will use the local build cache for tests.\n")
  write(dir, "docs/b.md", `# Large\n\n- ${"y".repeat(300)}\n`)
  write(dir, "docs/c.bin", "\0binary")
  write(dir, "docs/d.md", "- Another note that is long enough to seed as a fact.\n")
  write(dir, "docs/deep/e.md", "- A deeply nested note that is long enough to seed.\n")
  write(dir, "docs/.git/g.md", "- Ignored git note that is long enough to seed.\n")
  symlinkSync(join(dir, "docs", "a.md"), join(dir, "docs", "link.md"))

  const plan = applySeed(db, dir, "docs/", { files: 1, bytes: 200, depth: 1 })
  assert.equal(plan.path, "docs")
  assert.equal(plan.isDir, true)
  assert.equal(plan.files, 1)
  assert.ok(plan.skipped >= 5)
  assert.ok(plan.errors.some((e) => e.includes("b.md") && e.includes("byte cap")))
  assert.ok(plan.errors.some((e) => e.includes("c.bin") && e.includes("unsupported extension")))
  assert.ok(plan.errors.some((e) => e.includes("d.md") && e.includes("file cap")))
  assert.ok(plan.errors.some((e) => e.includes("deep") && e.includes("depth cap")))
  assert.ok(plan.errors.some((e) => e.includes(".git") && e.includes("excluded directory")))
  assert.ok(plan.errors.some((e) => e.includes("link.md") && e.includes("symlink")))
  assert.equal(countFacts(db), 1)
})

test("explicit markers classify kind and rank without a reason", async () => {
  const { dir, db } = await makeEnv()
  write(
    dir,
    "markers.md",
    `# Markers

- [decision] We will switch to SQLite for the main database.
- Pitfall: The cache ignores null values and returns stale rows.
- [debt] Refactor the legacy parser before adding more features.
- TODO: Follow up on the flaky deploy script tomorrow.
- Open question: Should we keep the old API around for clients?
- Gotcha: A failed build leaves stale artifacts behind. (verified: 2026-01-15)
`,
  )
  const plan = applySeed(db, dir, "markers.md")
  assert.equal(plan.blocks.length, 6)
  const expected = [
    ["decision", "high"],
    ["gotcha", "high"],
    ["debt", "medium"],
    ["reminder", "medium"],
    ["reminder", "medium"],
    ["gotcha", "high"],
  ]
  plan.blocks.forEach((block, i) => {
    assert.equal(block.kind, expected[i][0], `block ${i} kind`)
    assert.equal(block.rank, expected[i][1], `block ${i} rank`)
  })
  assert.ok(plan.changes.every((c) => c.reason === undefined))
  assert.equal(plan.blocks[0].anchor, "markers-1")
  assert.equal(plan.blocks[5].verified, "2026-01-15")

  for (const change of plan.changes) {
    assert.ok(change.id)
    const fact = getFact(db, change.id)!
    assert.equal(fact.kind, change.block.kind)
    assert.equal(fact.rank, change.block.rank)
    assert.equal(fact.source, "seed")
    assert.equal(fact.scope, "markers.md")
    assert.equal(fact.origin, `markers.md#${change.block.anchor}`)
  }
})

test("keyword heuristics and fallback record a classification reason", async () => {
  const { dir, db } = await makeEnv()
  write(
    dir,
    "heuristics.md",
    `# Heuristics

- We'll use the new parser for every import in the build.
- The build failed because npm ignored the lockfile completely.
- We need to review the flaky deploy script next week.
- Refactor the legacy parser before adding any new features.
- The weekly report lives on the shared drive for the whole team.
`,
  )
  const plan = applySeed(db, dir, "heuristics.md")
  assert.equal(plan.blocks.length, 5)
  assert.equal(plan.blocks[0].kind, "decision")
  assert.equal(plan.blocks[0].rank, "high")
  assert.match(plan.changes[0].reason ?? "", /keyword/)
  assert.equal(plan.blocks[1].kind, "gotcha")
  assert.equal(plan.blocks[1].rank, "high")
  assert.equal(plan.blocks[2].kind, "reminder")
  assert.match(plan.changes[2].reason ?? "", /keyword/)
  assert.equal(plan.blocks[3].kind, "debt")
  assert.equal(plan.blocks[3].rank, "medium")
  assert.equal(plan.blocks[4].kind, "reminder")
  assert.equal(plan.blocks[4].rank, "medium")
  assert.match(plan.changes[4].reason ?? "", /fallback/)
})

test("applySeed is idempotent", async () => {
  const { dir, db } = await makeEnv()
  write(
    dir,
    "stable.md",
    `# Stable

- [decision] We will use SQLite for the embedded store.
- [gotcha] A failed build leaves stale artifacts behind.
- The weekly report lives on the shared drive for the whole team.
`,
  )
  const first = applySeed(db, dir, "stable.md")
  const ids = first.changes.map((c) => c.id)
  assert.ok(ids.every((id) => typeof id === "number"))
  assert.equal(new Set(ids).size, 3)

  const second = applySeed(db, dir, "stable.md")
  assert.equal(countFacts(db), 3)
  assert.ok(second.changes.every((c) => c.status === "unchanged"))
  assert.deepEqual(second.changes.map((c) => c.id), ids)

  const third = applySeed(db, dir, "stable.md")
  assert.ok(third.changes.every((c) => c.status === "unchanged"))
  assert.equal(countFacts(db), 3)
})

test("changedSeedScopes detects a user edit and force reports all scopes", async () => {
  const { dir, db } = await makeEnv()
  const file = `# Notes

- [decision] We will use SQLite for the embedded store.
- The weekly report lives on the shared drive for the whole team.
`
  write(dir, "notes.md", file)
  applySeed(db, dir, "notes.md")
  assert.deepEqual(changedSeedScopes(db, dir), [])

  write(dir, "notes.md", file.replace("SQLite", "Postgres"))
  const changed = changedSeedScopes(db, dir)
  assert.equal(changed.length, 1)
  assert.equal(changed[0].path, "notes.md")
  assert.ok(changed[0].reason.length > 0)
  assert.ok(changed[0].added + changed[0].removed + changed[0].changed > 0)

  applySeed(db, dir, "notes.md")
  assert.deepEqual(changedSeedScopes(db, dir), [])
  const forced = changedSeedScopes(db, dir, true)
  assert.equal(forced.length, 1)
  assert.equal(forced[0].reason, "forced")

  resetSeedScopes(db)
  assert.equal(scopeCount(db), 0)
})

test("re-seed of one scope never demotes facts from another scope", async () => {
  const { dir, db } = await makeEnv()
  mkdirSync(join(dir, "scopes"), { recursive: true })
  write(
    dir,
    "scopes/one.md",
    `# One

- The legacy exporter keeps every row in the original import order.
- The cache ignores null values and returns stale rows on reads.
`,
  )
  write(
    dir,
    "scopes/two.md",
    `# Two

- The scheduler uses UTC for every cron expression in production.
- A missed heartbeat leaves the worker marked healthy for clients.
`,
  )
  const one = applySeed(db, dir, "scopes/one.md")
  const two = applySeed(db, dir, "scopes/two.md")
  assert.equal(countFacts(db), 4)
  const oneIds = one.changes.map((c) => c.id!)
  const twoIds = two.changes.map((c) => c.id!)
  const twoBefore = twoIds.map((id) => getFact(db, id)!)

  write(dir, "scopes/one.md", "# One\n")
  const rest = applySeed(db, dir, "scopes/one.md")
  const demoted = rest.changes.filter((c) => c.status === "demoted")
  assert.equal(demoted.length, 2)
  assert.deepEqual(new Set(demoted.map((c) => c.id)), new Set(oneIds))
  for (const id of oneIds) assert.equal(getFact(db, id)!.rank, "low")

  twoBefore.forEach((before, i) => {
    const after = getFact(db, twoIds[i])!
    assert.equal(after.rank, before.rank)
    assert.equal(after.kind, before.kind)
    assert.equal(after.origin, before.origin)
  })
})

test("absolute and escaping paths are rejected without DB writes", async () => {
  const { dir, db } = await makeEnv()
  const escape = planSeed(db, dir, "../outside.md")
  assert.ok(escape.errors.some((e) => /escape/i.test(e)))
  assert.equal(escape.blocks.length, 0)
  assert.equal(escape.changes.length, 0)

  const absolute = planSeed(db, dir, join(dir, "notes.md"))
  assert.ok(absolute.errors.some((e) => /absolute/i.test(e)))

  const applied = applySeed(db, dir, "../outside.md")
  assert.equal(applied.errors.length, 1)
  assert.equal(countFacts(db), 0)
  assert.equal(scopeCount(db), 0)
})
