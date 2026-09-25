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

const system = { system: [] as string[] }
await (hooks as any)["experimental.chat.system.transform"]({}, system)
console.log("--- system prompt injected:", system.system.length === 1)
console.log(system.system[0].slice(0, 300))

const seedDry = await (hooks as any).tool.hw_memory_seed.execute({})
console.log("--- hw_memory_seed dry-run:", seedDry.split("\n")[0])
const seedApply = await (hooks as any).tool.hw_memory_seed.execute({ apply: true })
console.log("--- hw_memory_seed applied:", seedApply.split("\n")[0])

const searchBefore = await (hooks as any).tool.hw_memory_search.execute({ query: "composer install vendor" })
console.log("--- hw_memory_search:", JSON.stringify(searchBefore))

const add = await (hooks as any).tool.hw_memory_add.execute({
  content: "Smoke test decision: sqlite is the only supported storage backend",
  kind: "decision",
  rank: "high",
})
console.log("--- hw_memory_add:", add)
console.log("--- docs/decisions.md written:", existsSync(join(root, "docs", "decisions.md")))
console.log(readFileSync(join(root, "docs", "decisions.md"), "utf8"))

const stats = await (hooks as any).tool.hw_memory_stats.execute({})
console.log("--- hw_memory_stats:", stats.split("\n").slice(0, 4).join(" | "))

const compaction = { context: [] as string[] }
await (hooks as any)["experimental.session.compacting"]({}, compaction)
console.log("--- compaction context injected:", compaction.context.length === 1)

await (hooks as any).event({ event: { type: "session.idle", properties: { sessionID: "s1" } } })
console.log("--- session.idle handled without error")

rmSync(root, { recursive: true, force: true })
console.log("SMOKE OK")
