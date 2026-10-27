import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HwMemoryPlugin } from "../plugin/hw-memory.ts"
import { fakeContext, text } from "../test/fake-context.ts"

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

const { ctx, tools, hooks, pushEvent } = fakeContext(root)
const cleanup = await HwMemoryPlugin.setup(ctx)
console.log("--- plugin id:", HwMemoryPlugin.id)

const system = { system: [] as { type: string; text: string }[] }
for (const hook of hooks.context) await hook(system)
console.log("--- system prompt injected:", system.system.length === 1)
console.log(system.system[0].text.slice(0, 200))

const seedDry = text(await tools.hw_memory_seed.execute({}))
console.log("--- hw_memory_seed dry-run:", seedDry.split("\n")[0])
const seedApply = text(await tools.hw_memory_seed.execute({ apply: true }))
console.log("--- hw_memory_seed applied:", seedApply.split("\n")[0])

const searchBefore = text(await tools.hw_memory_search.execute({ query: "composer install vendor" }))
console.log("--- hw_memory_search:", JSON.stringify(searchBefore))

const configBefore = text(await tools.hw_memory_config.execute({}))
console.log("--- hw_memory_config default:", configBefore.replace(/\n/g, " | "))
await tools.hw_memory_config.execute({ entity: "decision", enabled: true })
const add = text(
  await tools.hw_memory_add.execute({
    content: "Smoke test decision: sqlite is the only supported storage backend",
    kind: "decision",
    rank: "high",
  }),
)
console.log("--- hw_memory_add:", add)
console.log("--- docs/hw-memory/decisions.md written:", existsSync(join(root, "docs", "hw-memory", "decisions.md")))
console.log(readFileSync(join(root, "docs", "hw-memory", "decisions.md"), "utf8"))

const debtAdd = text(
  await tools.hw_memory_add.execute({
    content: "Smoke test debt: unrelated exporter drops the trailing separator token",
    kind: "debt",
    rank: "high",
  }),
)
console.log("--- debt add:", debtAdd)
const debtList = text(await tools.hw_memory_debt.execute({ action: "list" }))
console.log("--- debt list:", debtList)
const debtId = Number(debtList.match(/#(\d+)/)[1])
console.log("--- debt resolve:", text(await tools.hw_memory_debt.execute({ action: "resolve", id: debtId })))

const stats = text(await tools.hw_memory_stats.execute({}))
console.log("--- hw_memory_stats:", stats.split("\n").slice(0, 6).join(" | "))

const compaction = { system: [] as { type: string; text: string }[] }
for (const hook of hooks.compaction) await hook(compaction)
console.log("--- compaction context injected:", compaction.system.length === 1)

pushEvent({ type: "session.idle", data: { sessionID: "s1" } })
await new Promise((resolve) => setTimeout(resolve, 50))
console.log("--- session.idle handled without error")

await cleanup()
rmSync(root, { recursive: true, force: true })
console.log("SMOKE OK")
