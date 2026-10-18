import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { DB } from "../src/db.ts"
import { openDBFile } from "../src/db.ts"
import { initSchema, addFact, searchFacts, getFact } from "../src/core.ts"
import { getTarget, setTarget } from "../src/config.ts"
import {
  discoverDocFiles,
  docsFooterLines,
  managedRank,
  parseDocFile,
  rankForPath,
  removeEntityLine,
  reSeedFromDocs,
  seedFromDocs,
  syncEntityToFile,
  writeEntity,
} from "../src/docs.ts"

let dir: string
let db: DB

const AGENTS_MD = `# Agents

## What this repo is

- This repo is a build system that compiles a client-specific theme with only needed modules.
- [Architecture overview](./docs/architecture/00-overview.md)
- Short bullet.

## Rules

- Don't edit anything under dist/ because every build regenerates it wholesale.
- PHP follows WordPress Coding Standards. (verified: 2026-09-18)
`

const DECISIONS_MD = `# Принципы и решения («не менять»)

## ADR-список

1. **REST — источник истины.** Имена актёров и жанров сверяются с REST, а не с предположениями.
2. **«Нет ожидаемых ошибок».** Любая ошибка считается неожиданной независимо от числа повторений. (проверено: 2026-09-18)
3. **Один прогон = одна папка**, отчёты не перезаписываются.

## Статус

Все перечисленные ADR — ACCEPTED.
`

const GOTCHAS_MD = `# Подводные камни

## Медиа

- **Range обязателен** при проверке доступности, иначе ложные таймауты на больших файлах. (проверено: 2026-09-15)
- **Токен в playback-URL — НЕ 3-частный JWT**, а 2-частный, decodeJwtPayload вернёт null.

## Среда

| Команда | Поведение |
|---|---|
| npm test | прогон |

\`\`\`
- bullet inside code fence must be ignored completely
\`\`\`

- SITE обязателен, без него конфиг падает сразу.
`

const CHANGELOG_MD = `# Changelog

- 2026-09-18: добавлен пресет s7.
`

const OVERVIEW_MD = `# Overview

## Build pipeline

- The build pipeline reads site.json and compiles only the modules the client needs.
- Assets are compiled with Sass and design tokens are CSS custom properties.
`

const RULES_MODULE_MD = `# Module rules

- New features belong to modules by default and only direct user command allows merging into core.
- Every module must declare its hooks in module.json.
`

const ROLES_MANAGER_MD = `# Manager

- Запуск полного набора: SITE=<id> npm test.
- Отчёты находятся в results/<site>/<дата>/summary.md.
`

function makeProject(): string {
  const root = mkdtempSync(join(tmpdir(), "hwm-docs-"))
  writeFileSync(join(root, "AGENTS.md"), AGENTS_MD)
  mkdirSync(join(root, "docs", "architecture"), { recursive: true })
  mkdirSync(join(root, "docs", "rules"), { recursive: true })
  mkdirSync(join(root, "docs", "roles"), { recursive: true })
  writeFileSync(join(root, "docs", "decisions.md"), DECISIONS_MD)
  writeFileSync(join(root, "docs", "gotchas.md"), GOTCHAS_MD)
  writeFileSync(join(root, "docs", "Changelog.md"), CHANGELOG_MD)
  writeFileSync(join(root, "docs", "architecture", "00-overview.md"), OVERVIEW_MD)
  writeFileSync(join(root, "docs", "rules", "rules-module.md"), RULES_MODULE_MD)
  writeFileSync(join(root, "docs", "roles", "manager.md"), ROLES_MANAGER_MD)
  return root
}

test.before(async () => {
  dir = makeProject()
  db = await openDBFile(join(dir, ".opencode", "hw-memory.db"))
  initSchema(db)
})

test.after(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

test("rankForPath mapping", () => {
  assert.deepEqual(rankForPath("docs/decisions.md"), { kind: "decision", rank: "critical" })
  assert.deepEqual(rankForPath("docs/gotchas.md"), { kind: "gotcha", rank: "high" })
  assert.deepEqual(rankForPath("docs/hw-memory/decisions.md"), { kind: "decision", rank: "critical" })
  assert.deepEqual(rankForPath("docs/hw-memory/debt.md"), { kind: "debt", rank: "medium" })
  assert.deepEqual(rankForPath("docs/context.md"), { kind: "fact", rank: "high" })
  assert.deepEqual(rankForPath("docs/architecture/00-overview.md"), { kind: "fact", rank: "high" })
  assert.deepEqual(rankForPath("docs/rules/rules-module.md"), { kind: "decision", rank: "critical" })
  assert.deepEqual(rankForPath("docs/roles/manager.md"), { kind: "fact", rank: "medium" })
  assert.deepEqual(rankForPath("docs/Changelog.md"), { kind: "changelog", rank: "low" })
  assert.deepEqual(rankForPath("AGENTS.md"), { kind: "fact", rank: "medium" })
  assert.deepEqual(rankForPath("README.md"), { kind: "fact", rank: "medium" })
  assert.equal(rankForPath(".opencode/rule/hw-memory.md"), null)
  assert.equal(rankForPath("node_modules/foo/docs/x.md"), null)
  assert.equal(rankForPath("random/notes.md"), null)
})

test("managedRank defaults per entity", () => {
  assert.equal(managedRank("decision"), "critical")
  assert.equal(managedRank("gotcha"), "high")
  assert.equal(managedRank("debt"), "medium")
})

test("parseDocFile extracts facts, skips fences, tables, short nav bullets", () => {
  const gotchas = parseDocFile(join(dir, "docs", "gotchas.md"), "docs/gotchas.md")
  assert.equal(gotchas.length, 3)
  assert.ok(gotchas.every((g) => g.kind === "gotcha" && g.rank === "high"))
  assert.ok(gotchas.some((g) => g.content.includes("Range обязателен")))
  assert.ok(gotchas.some((g) => g.content.includes("SITE обязателен")))
  assert.ok(!gotchas.some((g) => g.content.includes("code fence")))
  assert.ok(!gotchas.some((g) => g.content.includes("npm test")))
  const range = gotchas.find((g) => g.content.includes("Range"))
  assert.equal(range!.verified, "2026-09-15")
  assert.equal(range!.origin, "docs/gotchas.md#медиа-1")

  const agents = parseDocFile(join(dir, "AGENTS.md"), "AGENTS.md")
  assert.ok(agents.some((a) => a.content.includes("build system that compiles")))
  assert.ok(!agents.some((a) => a.content.includes("Architecture overview")))
  assert.ok(agents.every((a) => a.rank === "medium"))
  const verifiedFact = agents.find((a) => a.content.includes("WordPress Coding Standards"))
  assert.equal(verifiedFact!.verified, "2026-09-18")

  const decisions = parseDocFile(join(dir, "docs", "decisions.md"), "docs/decisions.md")
  assert.equal(decisions.length, 3)
  assert.deepEqual(
    decisions.map((d) => d.origin),
    ["docs/decisions.md#1", "docs/decisions.md#2", "docs/decisions.md#3"],
  )
  assert.ok(decisions.every((d) => d.kind === "decision" && d.rank === "critical"))
  const second = decisions[1]
  assert.equal(second.verified, "2026-09-18")
})

const ANCHOR_COLLISION_MD = `# Readme

## Alpha

1. The first alpha rule applies to every build target in the repository.

## Beta Section

1. The beta rule is the first numbered item written in the beta section.
- A beta bullet that must not collide with the numbered beta item above.
`

test("parseDocFile keeps anchors unique when a numbered fallback meets a bullet", () => {
  const root = makeTempProject({ "README.md": ANCHOR_COLLISION_MD })
  const facts = parseDocFile(join(root, "README.md"), "README.md")
  const origins = facts.map((f) => f.origin)
  assert.equal(origins.length, 3)
  assert.equal(new Set(origins).size, origins.length)
  assert.equal(origins.filter((o) => o.endsWith("#beta-section-1")).length, 1)
  rmSync(root, { recursive: true, force: true })
})

test("reSeed does not throw when a numbered fallback meets a bullet anchor", async () => {
  const root = makeTempProject({ "README.md": ANCHOR_COLLISION_MD })
  const dbx = await openDBFile(join(root, ".opencode", "hw-memory.db"))
  initSchema(dbx)
  const first = reSeedFromDocs(dbx, root, true)
  assert.equal(first.inserted, 3)
  const dupes = dbx
    .prepare("SELECT origin FROM memories WHERE source = 'seed' AND origin IS NOT NULL GROUP BY origin HAVING COUNT(*) > 1")
    .all()
  assert.equal(dupes.length, 0)
  const second = reSeedFromDocs(dbx, root, true)
  assert.equal(second.inserted, 0)
  assert.equal(rowCount(dbx), 3)
  dbx.close()
  rmSync(root, { recursive: true, force: true })
})

test("reSeed rebinds swapped origins without hitting the unique index", async () => {
  const rel = "docs/context.md"
  const first = "The parser reads the grammar file and compiles a token table for the lexer."
  const second = "The lexer scans the source stream and emits tokens for the parser to reduce."
  const root = makeTempProject({ [rel]: `# Context\n\n## Parser\n\n- ${first}\n- ${second}\n` })
  const dbx = await openDBFile(join(root, ".opencode", "hw-memory.db"))
  initSchema(dbx)
  const o1 = "docs/context.md#parser-1"
  const o2 = "docs/context.md#parser-2"
  addFact(dbx, { content: first, kind: "fact", rank: "high", source: "seed", origin: o2, exact: true })
  addFact(dbx, { content: second, kind: "fact", rank: "high", source: "seed", origin: o1, exact: true })
  const report = reSeedFromDocs(dbx, root, true)
  assert.equal(report.rebound, 2)
  assert.equal(rowCount(dbx), 2)
  const origins = (dbx.prepare("SELECT origin FROM memories WHERE source = 'seed' ORDER BY origin").all() as any[]).map(
    (r) => r.origin,
  )
  assert.deepEqual(origins, [o1, o2])
  const again = reSeedFromDocs(dbx, root, true)
  assert.equal(again.rebound, 0)
  assert.equal(again.inserted, 0)
  dbx.close()
  rmSync(root, { recursive: true, force: true })
})

test("discoverDocFiles finds known layout", () => {
  const files = discoverDocFiles(dir)
  const rels = files.map((f) => f.rel)
  assert.ok(rels.includes("AGENTS.md"))
  assert.ok(rels.includes("docs/decisions.md"))
  assert.ok(rels.includes("docs/architecture/00-overview.md"))
  assert.ok(rels.includes("docs/rules/rules-module.md"))
  assert.ok(rels.includes("docs/roles/manager.md"))
})

test("seedFromDocs inserts and is idempotent", () => {
  const first = seedFromDocs(db, dir)
  assert.ok(first.inserted > 10)
  assert.equal(first.facts, first.inserted + first.updated)
  const second = seedFromDocs(db, dir)
  assert.equal(second.inserted, 0)
  assert.equal(second.updated, first.facts)
})

test("seeded facts are searchable", () => {
  const hits = searchFacts(db, "JWT токен playback", { limit: 3 })
  assert.ok(hits.length >= 1)
  assert.ok(hits[0].content.includes("JWT"))
  assert.equal(hits[0].origin, "docs/gotchas.md#медиа-2")
})

test("reSeed dry-run then apply: new doc fact gets inserted", () => {
  writeFileSync(
    join(dir, "docs", "gotchas.md"),
    GOTCHAS_MD + "\n- Новая ловушка про миграции базы данных при обновлении пресета.\n",
  )
  const dry = reSeedFromDocs(db, dir, false)
  assert.equal(dry.apply, false)
  assert.equal(dry.inserted, 1)
  const applied = reSeedFromDocs(db, dir, true)
  assert.equal(applied.inserted, 1)
  const again = reSeedFromDocs(db, dir, true)
  assert.equal(again.inserted, 0)
  assert.equal(again.updatedContent, 0)
})

test("reSeed detects edited content at same origin", () => {
  const edited = DECISIONS_MD.replace(
    "Один прогон = одна папка",
    "Один прогон = одна папка с датой в имени",
  )
  writeFileSync(join(dir, "docs", "decisions.md"), edited)
  const dry = reSeedFromDocs(db, dir, false)
  assert.equal(dry.updatedContent, 1)
  reSeedFromDocs(db, dir, true)
  const hits = searchFacts(db, "прогон папка дата", { limit: 5, kinds: ["decision"] })
  assert.ok(hits.some((h) => h.content.includes("с датой в имени")))
  assert.ok(!hits.some((h) => h.content === "Один прогон = одна папка, отчёты не перезаписываются."))
})

test("reSeed demotes vanished seed facts", () => {
  writeFileSync(join(dir, "docs", "rules", "rules-module.md"), "# Module rules\n\n- Only a completely new rule set replacing the old one entirely.\n")
  const report = reSeedFromDocs(db, dir, true)
  assert.ok(report.demoted >= 1 || report.rebound >= 1)
})

test("reSeed reports crucial facts missing from docs", () => {
  addFact(db, {
    content: "Agent-made crucial decision about deploying on Fridays being forbidden",
    kind: "decision",
    rank: "high",
    source: "agent",
  })
  const report = reSeedFromDocs(db, dir, false)
  assert.ok(report.missingFromDocs.some((m) => m.content.includes("deploying on Fridays")))
})

test("writeEntity appends decision before Status section with next number", () => {
  const rel = "docs/hw-memory/decisions.md"
  mkdirSync(join(dir, "docs", "hw-memory"), { recursive: true })
  writeFileSync(join(dir, rel), DECISIONS_MD)
  const res = writeEntity(dir, "decision", rel, "Auto decision appended by the memory tool itself", "critical", [
    "auto",
    "decision",
  ])
  assert.equal(res.written, true)
  assert.equal(res.origin, `${rel}#4`)
  const after = readFileSync(join(dir, rel), "utf8")
  assert.ok(after.includes("4. **Auto Decision**: Auto decision appended by the memory tool itself"))
  const statusIdx = after.indexOf("## Статус")
  const itemIdx = after.indexOf("4. **Auto Decision**")
  assert.ok(statusIdx > itemIdx)
})

test("writeEntity appends gotcha into current month section", () => {
  const rel = "docs/hw-memory/gotchas.md"
  mkdirSync(join(dir, "docs", "hw-memory"), { recursive: true })
  writeFileSync(join(dir, rel), GOTCHAS_MD)
  const res = writeEntity(dir, "gotcha", rel, "Resolved pitfall about sqlite locking under parallel workers", "high", [
    "sqlite",
    "locking",
  ])
  assert.equal(res.written, true)
  const text = readFileSync(join(dir, rel), "utf8")
  const month = new Date().toISOString().slice(0, 7)
  assert.ok(text.includes(`## ${month}`))
  assert.ok(text.includes("Resolved pitfall about sqlite locking"))
  const monthIdx = text.indexOf(`## ${month}`)
  const itemIdx = text.indexOf("Resolved pitfall about sqlite locking")
  assert.ok(itemIdx > monthIdx)
})

test("writeEntity writes debt with severity and creates missing files", () => {
  const fresh = mkdtempSync(join(tmpdir(), "hwm-fresh-"))
  const rel = "docs/hw-memory/debt.md"
  const res = writeEntity(fresh, "debt", rel, "First ever debt captured in a brand new project", "high", ["first"])
  assert.equal(res.origin, `${rel}#${new Date().toISOString().slice(0, 7)}`)
  const text = readFileSync(join(fresh, rel), "utf8")
  assert.ok(text.startsWith("# Technical Debt"))
  assert.ok(text.includes("**[high] First**: First ever debt captured"))
  rmSync(fresh, { recursive: true, force: true })
})

test("syncEntityToFile appends missing facts and is idempotent", async () => {
  const fresh = mkdtempSync(join(tmpdir(), "hwm-sync-"))
  const freshDb = await openDBFile(join(fresh, ".opencode", "hw-memory.db"))
  initSchema(freshDb)
  setTarget(freshDb, "decision", { enabled: true, path: "docs/hw-memory/decisions.md" })
  addFact(freshDb, {
    content: "Decisions are synced into the managed file automatically",
    kind: "decision",
    rank: "critical",
    source: "agent",
  })
  const first = syncEntityToFile(freshDb, fresh, "decision")
  assert.equal(first.written, 1)
  const second = syncEntityToFile(freshDb, fresh, "decision")
  assert.equal(second.written, 0)
  const text = readFileSync(join(fresh, "docs", "hw-memory", "decisions.md"), "utf8")
  assert.equal(text.match(/managed file automatically/g)?.length, 1)
  freshDb.close()
  rmSync(fresh, { recursive: true, force: true })
})

test("removeEntityLine prunes a synced managed file line", async () => {
  const fresh = mkdtempSync(join(tmpdir(), "hwm-remove-"))
  const freshDb = await openDBFile(join(fresh, ".opencode", "hw-memory.db"))
  initSchema(freshDb)
  setTarget(freshDb, "debt", { enabled: true })
  addFact(freshDb, {
    content: "The old importer cannot handle multi-byte separator tokens",
    kind: "debt",
    rank: "high",
    source: "agent",
  })
  const sync = syncEntityToFile(freshDb, fresh, "debt")
  assert.equal(sync.written, 1)
  const rows = searchFacts(freshDb, "multi-byte separator tokens", { kinds: ["debt"] })
  assert.equal(rows.length, 1)
  assert.equal(removeEntityLine(fresh, sync.file, rows[0].content), true)
  assert.ok(!readFileSync(join(fresh, sync.file), "utf8").includes("multi-byte separator"))
  freshDb.close()
  rmSync(fresh, { recursive: true, force: true })
})

test("docsFooterLines lists enabled existing managed targets", () => {
  setTarget(db, "decision", { enabled: true, path: "docs/decisions.md" })
  setTarget(db, "gotcha", { enabled: true, path: "docs/gotchas.md" })
  const footer = docsFooterLines(dir, db)
  assert.ok(footer.some((f) => f.startsWith("docs/decisions.md")))
  assert.ok(footer.some((f) => f.startsWith("docs/gotchas.md")))
  assert.ok(!footer.some((f) => f.includes("docs/context.md")))
})

test("file targets are disabled by default and settable", () => {
  assert.equal(getTarget(db, "debt").enabled, false)
  const updated = setTarget(db, "debt", { enabled: true, path: "docs/hw-memory/debt.md" })
  assert.deepEqual(updated, { kind: "debt", enabled: true, path: "docs/hw-memory/debt.md" })
  setTarget(db, "debt", { enabled: false })
})

function makeTempProject(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "hwm-reseed-"))
  for (const [rel, text] of Object.entries(files)) {
    const abs = join(root, rel)
    mkdirSync(join(abs, ".."), { recursive: true })
    writeFileSync(abs, text)
  }
  return root
}

function rowCount(database: DB): number {
  return (database.prepare("SELECT COUNT(*) AS c FROM memories").get() as any).c as number
}

test("reSeed apply is a fixed point and never absorbs near-duplicates", async () => {
  const root = makeTempProject({
    "AGENTS.md": "# Agents\n\n- Always run the full parser suite before committing changes to the grammar.\n",
    "docs/context.md": "# Context\n\n## Parser\n\n- Always run the full parser test suite before committing any grammar changes.\n",
  })
  const dbx = await openDBFile(join(root, ".opencode", "hw-memory.db"))
  initSchema(dbx)
  const first = reSeedFromDocs(dbx, root, true)
  assert.equal(first.inserted, 2)
  assert.equal(rowCount(dbx), 2)
  const second = reSeedFromDocs(dbx, root, true)
  assert.equal(second.inserted, 0)
  assert.equal(second.updatedContent, 0)
  assert.equal(second.rebound, 0)
  assert.equal(second.demoted, 0)
  assert.equal(second.merged, 0)
  assert.equal(rowCount(dbx), 2)
  dbx.close()
  rmSync(root, { recursive: true, force: true })
})

test("reSeed dry-run classifies the same as apply", async () => {
  const contextRel = "docs/context.md"
  const original = "# Context\n\n## Build\n\n- The build pipeline compiles the theme modules the client needs.\n- The pipeline writes all output into the dist folder.\n"
  const root = makeTempProject({ [contextRel]: original })
  const dbx = await openDBFile(join(root, ".opencode", "hw-memory.db"))
  initSchema(dbx)
  reSeedFromDocs(dbx, root, true)
  writeFileSync(
    join(root, contextRel),
    "# Context\n\n## Build\n\n- The build pipeline compiles only the theme modules the client needs.\n\n## Deploy\n\n- Deployment copies the compiled bundle to the staging server.\n",
  )
  const dry = reSeedFromDocs(dbx, root, false)
  const applied = reSeedFromDocs(dbx, root, true)
  const pick = (r: ReturnType<typeof reSeedFromDocs>) => ({
    inserted: r.inserted,
    updatedContent: r.updatedContent,
    rebound: r.rebound,
    demoted: r.demoted,
    merged: r.merged,
  })
  assert.deepEqual(pick(dry), pick(applied))
  assert.equal(applied.updatedContent, 1)
  assert.equal(applied.demoted, 1)
  assert.equal(applied.inserted, 1)
  const again = reSeedFromDocs(dbx, root, true)
  assert.equal(again.inserted, 0)
  assert.equal(again.updatedContent, 0)
  assert.equal(again.rebound, 0)
  assert.equal(again.demoted, 0)
  assert.equal(again.merged, 0)
  dbx.close()
  rmSync(root, { recursive: true, force: true })
})

test("reSeed does not throw on legacy duplicate origins and restores uniqueness", async () => {
  const origin = "docs/roles/manager.md#runs-1"
  const docText = "# Manager\n\n## Runs\n\n- Run the complete suite with SITE=<id> npm test for every release.\n"
  const root = makeTempProject({ "docs/roles/manager.md": docText })
  const dbx = await openDBFile(join(root, ".opencode", "hw-memory.db"))
  initSchema(dbx)
  dbx.exec("DROP INDEX IF EXISTS ux_memories_seed_origin")
  const doc = parseDocFile(join(root, "docs/roles/manager.md"), "docs/roles/manager.md")[0]
  assert.equal(doc.origin, origin)
  addFact(dbx, { content: doc.content, kind: doc.kind, rank: doc.rank, source: "seed", origin, exact: true })
  addFact(dbx, {
    content: "A totally unrelated legacy note about widgets and gadgets.",
    kind: "fact",
    rank: "low",
    source: "seed",
    origin,
    exact: true,
  })
  assert.equal(rowCount(dbx), 2)
  const report = reSeedFromDocs(dbx, root, true)
  assert.ok(report.merged >= 1)
  const dupes = dbx
    .prepare("SELECT origin FROM memories WHERE source = 'seed' AND origin IS NOT NULL GROUP BY origin HAVING COUNT(*) > 1")
    .all()
  assert.equal(dupes.length, 0)
  assert.equal(rowCount(dbx), 1)
  dbx.close()
  rmSync(root, { recursive: true, force: true })
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
  assert.throws(() =>
    insert("another duplicate", "h-gamma", "medium", 0),
  )
  dbx.close()
  rmSync(root, { recursive: true, force: true })
})

