import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { DB } from "../src/db.ts"
import { openDBFile } from "../src/db.ts"
import { initSchema, addFact, searchFacts, getFact } from "../src/core.ts"
import {
  discoverDocFiles,
  docsFooterLines,
  parseDocFile,
  rankForPath,
  reSeedFromDocs,
  seedFromDocs,
  writeCrucialToDocs,
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
  assert.deepEqual(rankForPath("docs/context.md"), { kind: "fact", rank: "high" })
  assert.deepEqual(rankForPath("docs/architecture/00-overview.md"), { kind: "fact", rank: "high" })
  assert.deepEqual(rankForPath("docs/rules/rules-module.md"), { kind: "decision", rank: "critical" })
  assert.deepEqual(rankForPath("docs/roles/manager.md"), { kind: "fact", rank: "medium" })
  assert.deepEqual(rankForPath("docs/Changelog.md"), { kind: "changelog", rank: "low" })
  assert.deepEqual(rankForPath("AGENTS.md"), { kind: "fact", rank: "medium" })
  assert.deepEqual(rankForPath("README.md"), { kind: "fact", rank: "medium" })
  assert.equal(rankForPath(".memory/ai/gotchas.md"), null)
  assert.equal(rankForPath(".opencode/rule/hw-memory.md"), null)
  assert.equal(rankForPath("node_modules/foo/docs/x.md"), null)
  assert.equal(rankForPath("random/notes.md"), null)
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

test("writeCrucialToDocs appends decision before Status section with next number", () => {
  const before = readFileSync(join(dir, "docs", "decisions.md"), "utf8")
  const res = writeCrucialToDocs(dir, {
    id: 0,
    content: "Auto decision appended by the memory tool itself",
    keywords: ["auto", "decision"],
    kind: "decision",
    rank: "critical",
  })
  assert.equal(res.written, true)
  assert.equal(res.origin, "docs/decisions.md#4")
  const after = readFileSync(join(dir, "docs", "decisions.md"), "utf8")
  assert.ok(after.includes("4. **Auto Decision**: Auto decision appended by the memory tool itself"))
  const statusIdx = after.indexOf("## Статус")
  const itemIdx = after.indexOf("4. **Auto Decision**")
  assert.ok(statusIdx > itemIdx)
  assert.ok(before.length < after.length)
})

test("writeCrucialToDocs appends gotcha into current month section", () => {
  const res = writeCrucialToDocs(dir, {
    id: 0,
    content: "Resolved pitfall about sqlite locking under parallel workers",
    keywords: ["sqlite", "locking"],
    kind: "gotcha",
    rank: "high",
  })
  assert.equal(res.written, true)
  const text = readFileSync(join(dir, "docs", "gotchas.md"), "utf8")
  const month = new Date().toISOString().slice(0, 7)
  assert.ok(text.includes(`## ${month}`))
  assert.ok(text.includes("Resolved pitfall about sqlite locking"))
  const monthIdx = text.indexOf(`## ${month}`)
  const itemIdx = text.indexOf("Resolved pitfall about sqlite locking")
  assert.ok(itemIdx > monthIdx)
})

test("writeCrucialToDocs creates missing files", () => {
  const fresh = mkdtempSync(join(tmpdir(), "hwm-fresh-"))
  const res = writeCrucialToDocs(fresh, {
    id: 0,
    content: "First ever decision captured in a brand new project",
    keywords: ["first"],
    kind: "decision",
    rank: "critical",
  })
  assert.equal(res.origin, "docs/decisions.md#1")
  const text = readFileSync(join(fresh, "docs", "decisions.md"), "utf8")
  assert.ok(text.includes("1. **First**: First ever decision"))
  rmSync(fresh, { recursive: true, force: true })
})

test("docsFooterLines lists only existing entries", () => {
  const footer = docsFooterLines(dir)
  assert.ok(footer.some((f) => f.startsWith("docs/decisions.md")))
  assert.ok(footer.some((f) => f.startsWith("docs/gotchas.md")))
  assert.ok(!footer.some((f) => f.includes("docs/context.md")))
})
