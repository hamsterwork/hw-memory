import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { DB } from "../src/db.ts"
import { openDBFile } from "../src/db.ts"
import { initSchema } from "../src/core.ts"
import { migrateMemoryDir } from "../src/migrate.ts"

function makeLegacyProject(): string {
  const root = mkdtempSync(join(tmpdir(), "hwm-mig-"))
  mkdirSync(join(root, ".memory", "ai"), { recursive: true })
  mkdirSync(join(root, ".memory", "history"), { recursive: true })
  mkdirSync(join(root, ".memory", "roles"), { recursive: true })
  writeFileSync(
    join(root, ".memory", "index.md"),
    "# Карта документации проекта (.memory)\n\n- Навигация по файлам.\n",
  )
  writeFileSync(
    join(root, ".memory", "history", "decisions.md"),
    `# Решения

## ADR

1. **REST — источник истины.** Сверка всегда с REST.
2. **Один прогон = одна папка.** Отчёты не перезаписываются.
`,
  )
  writeFileSync(
    join(root, ".memory", "ai", "gotchas.md"),
    `# Грабли

## Среда

- SITE обязателен, без него конфиг падает сразу.
`,
  )
  writeFileSync(
    join(root, ".memory", "ai", "context.md"),
    `# Контекст

## Стенды

- krr.test — локальный HTTP без auth, все медиа заглушки.
`,
  )
  writeFileSync(join(root, ".memory", "history", "changelog.md"), "# Хроника\n\n- 2026-09-18: добавлен пресет.\n")
  writeFileSync(join(root, ".memory", "roles", "manager.md"), "# Manager\n\n- Запуск: SITE=<id> npm test.\n")
  return root
}

test("migrate dry-run reports plan without writing", async () => {
  const root = makeLegacyProject()
  const db = await openDBFile(join(root, ".opencode", "hw-memory.db"))
  initSchema(db)
  const report = migrateMemoryDir(db, root, false)
  assert.equal(report.apply, false)
  assert.equal(report.memoryDirFound, true)
  assert.equal(report.copied.length, 5)
  assert.ok(report.copied.some((c) => c.from === ".memory/history/decisions.md" && c.to === "docs/decisions.md"))
  assert.ok(report.copied.some((c) => c.from === ".memory/roles/manager.md" && c.to === "docs/roles/manager.md"))
  assert.ok(report.reviewManually.includes(".memory/index.md"))
  assert.equal(report.agentsUpdated, true)
  assert.equal(report.seed, null)
  assert.equal(existsSync(join(root, "docs")), false)
  db.close()
  rmSync(root, { recursive: true, force: true })
})

test("migrate apply copies, seeds, updates AGENTS.md, keeps .memory", async () => {
  const root = makeLegacyProject()
  writeFileSync(join(root, "AGENTS.md"), "# Agents\n\n- Existing agents file.\n")
  const db = await openDBFile(join(root, ".opencode", "hw-memory.db"))
  initSchema(db)
  const report = migrateMemoryDir(db, root, true)
  assert.equal(report.copied.length, 5)
  assert.ok(existsSync(join(root, "docs", "decisions.md")))
  assert.ok(existsSync(join(root, "docs", "gotchas.md")))
  assert.ok(existsSync(join(root, "docs", "context.md")))
  assert.ok(existsSync(join(root, "docs", "Changelog.md")))
  assert.ok(existsSync(join(root, "docs", "roles", "manager.md")))
  assert.ok(existsSync(join(root, ".memory", "index.md")))
  const agents = readFileSync(join(root, "AGENTS.md"), "utf8")
  assert.match(agents, /## Documentation/)
  assert.match(agents, /docs\/decisions\.md/)
  assert.ok(report.seed)
  assert.ok(report.seed.inserted > 5)
  const seededAgain = migrateMemoryDir(db, root, false)
  assert.equal(seededAgain.memoryDirFound, true)
  db.close()
  rmSync(root, { recursive: true, force: true })
})

test("migrate merge renumbers decisions continuing from target", async () => {
  const root = makeLegacyProject()
  mkdirSync(join(root, "docs"), { recursive: true })
  writeFileSync(
    join(root, "docs", "decisions.md"),
    `# Decisions

1. **Existing decision.** Already in docs.
2. **Second existing.** Also here.
`,
  )
  const db = await openDBFile(join(root, ".opencode", "hw-memory.db"))
  initSchema(db)
  const report = migrateMemoryDir(db, root, true)
  const mergedFile = report.copied.find((c) => c.to === "docs/decisions.md")
  assert.equal(mergedFile!.merged, true)
  const text = readFileSync(join(root, "docs", "decisions.md"), "utf8")
  assert.match(text, /3\. \*\*REST — источник истины\.\*\*/)
  assert.match(text, /4\. \*\*Один прогон = одна папка\.\*\*/)
  assert.match(text, /## Migrated from \.memory \(\d{4}-\d{2}-\d{2}\)/)
  db.close()
  rmSync(root, { recursive: true, force: true })
})

test("migrate with no .memory reports nothing", async () => {
  const root = mkdtempSync(join(tmpdir(), "hwm-empty-"))
  const db = await openDBFile(join(root, ".opencode", "hw-memory.db"))
  initSchema(db)
  const report = migrateMemoryDir(db, root, true)
  assert.equal(report.memoryDirFound, false)
  assert.equal(report.copied.length, 0)
  db.close()
  rmSync(root, { recursive: true, force: true })
})

test("unknown .memory files land in docs/memory/", async () => {
  const root = makeLegacyProject()
  writeFileSync(join(root, ".memory", "ai", "krr.md"), "# KRR\n\n- Особенности стенда krr-dev.\n")
  const db = await openDBFile(join(root, ".opencode", "hw-memory.db"))
  initSchema(db)
  const report = migrateMemoryDir(db, root, true)
  assert.ok(report.copied.some((c) => c.from === ".memory/ai/krr.md" && c.to === "docs/memory/ai/krr.md"))
  db.close()
  rmSync(root, { recursive: true, force: true })
})
