import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HwMemoryPlugin } from "../plugin/hw-memory.ts"

const root = mkdtempSync(join(tmpdir(), "hwm-smoke-"))
mkdirSync(join(root, "docs"), { recursive: true })
writeFileSync(
  join(root, "AGENTS.md"),
  "# Agents\n\n## Rules\n\n- All builds run through npm run build before deployment to any environment.\n",
)
writeFileSync(
  join(root, "docs", "gotchas.md"),
  "# Gotchas\n\n## 2026-08\n\n- Stale vendor folder breaks composer install, remove it before rebuilding.\n",
)

const client = {
  app: { log: async () => {} },
  session: { messages: async () => ({ data: [] }) },
}

const hooks = await HwMemoryPlugin({
  directory: root,
  worktree: root,
  client,
} as any)
const tools = (hooks as any).tool

const system = { system: [] as string[] }
await (hooks as any)["experimental.chat.system.transform"]({}, system)
console.log("--- system prompt injected:", system.system.length === 1)
console.log(system.system[0].slice(0, 200))

const seedDry = await tools.hw_memory_seed.execute({})
console.log("--- hw_memory_seed dry-run:", seedDry.split("\n")[0])
const seedApply = await tools.hw_memory_seed.execute({ apply: true })
console.log("--- hw_memory_seed applied:", seedApply.split("\n")[0])

const searchBefore = await tools.hw_memory_search.execute({ query: "composer install vendor" })
console.log("--- hw_memory_search:", JSON.stringify(searchBefore))

const configBefore = await tools.hw_memory_config.execute({})
console.log("--- hw_memory_config default:", configBefore.replace(/\n/g, " | "))
await tools.hw_memory_config.execute({ entity: "decision", enabled: true })
const add = await tools.hw_memory_add.execute({
  content: "Smoke test decision: sqlite is the only supported storage backend",
  kind: "decision",
  rank: "high",
})
console.log("--- hw_memory_add:", add)
console.log("--- docs/hw-memory/decisions.md written:", existsSync(join(root, "docs", "hw-memory", "decisions.md")))
console.log(readFileSync(join(root, "docs", "hw-memory", "decisions.md"), "utf8"))

const debtAdd = await tools.hw_memory_add.execute({
  content: "Smoke test debt: unrelated exporter drops the trailing separator token",
  kind: "debt",
  rank: "high",
})
console.log("--- debt add:", debtAdd)
const debtList = await tools.hw_memory_debt.execute({ action: "list" })
console.log("--- debt list:", debtList)
const debtId = Number(debtList.match(/#(\d+)/)[1])
console.log("--- debt resolve:", await tools.hw_memory_debt.execute({ action: "resolve", id: debtId }))

mkdirSync(join(root, "notes"), { recursive: true })
writeFileSync(join(root, "notes", "legacy.md"), "# Legacy\n\n- **Old bug**: retry loop never increments the attempt counter.\n")
console.log(
  "--- hw_memory_file rework:",
  await tools.hw_memory_file.execute({ kind: "debt", file: "notes/legacy.md", rework: true }),
)

const stats = await tools.hw_memory_stats.execute({})
console.log("--- hw_memory_stats:", stats.split("\n").slice(0, 6).join(" | "))

const compaction = { context: [] as string[] }
await (hooks as any)["experimental.session.compacting"]({}, compaction)
console.log("--- compaction context injected:", compaction.context.length === 1)

await (hooks as any).event({ event: { type: "session.idle", properties: { sessionID: "s1" } } })
console.log("--- session.idle handled without error")

rmSync(root, { recursive: true, force: true })
console.log("SMOKE OK")
