import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HwMemoryPlugin } from "../src/hw-memory.ts"

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "hwm-plugin-"))
  mkdirSync(join(root, "docs"), { recursive: true })
  const client = { session: { messages: async () => ({ data: [] }) } }
  const hooks: any = await HwMemoryPlugin({ directory: root, worktree: root, client } as any)
  return { root, tools: hooks.tool as Record<string, { execute: (args: any) => Promise<string> }> }
}

const TOOL_NAMES = [
  "hw_memory_add",
  "hw_memory_search",
  "hw_memory_stats",
  "hw_memory_forget",
  "hw_memory_seed",
  "hw_memory_debt",
  "hw_memory_config",
]

test("plugin registers all tools", async () => {
  const { root, tools } = await setup()
  for (const name of TOOL_NAMES) {
    assert.equal(typeof tools[name].execute, "function", `missing tool ${name}`)
  }
  rmSync(root, { recursive: true, force: true })
})

test("debt flow: add warns, list shows, resolve deletes", async () => {
  const { root, tools } = await setup()
  const add = await tools.hw_memory_add.execute({
    content: "unrelated serializer mismatch found while editing docs",
    kind: "debt",
    rank: "high",
  })
  assert.match(add, /Technical debt recorded/)
  const list = await tools.hw_memory_debt.execute({ action: "list" })
  assert.match(list, /serializer mismatch/)
  const id = Number(list.match(/#(\d+)/)![1])
  const resolved = await tools.hw_memory_debt.execute({ action: "resolve", id })
  assert.match(resolved, /Resolved/)
  assert.equal(await tools.hw_memory_debt.execute({ action: "list" }), "No open technical debt.")
  rmSync(root, { recursive: true, force: true })
})

test("enabling a target makes add write the managed file", async () => {
  const { root, tools } = await setup()
  const before = await tools.hw_memory_config.execute({})
  assert.match(before, /decision: disabled/)
  await tools.hw_memory_config.execute({ entity: "decision", enabled: true })
  const add = await tools.hw_memory_add.execute({
    content: "decided to keep sqlite as the only storage backend",
    kind: "decision",
    rank: "critical",
  })
  assert.match(add, /docs\/hw-memory\/decisions\.md/)
  assert.ok(existsSync(join(root, "docs", "hw-memory", "decisions.md")))
  rmSync(root, { recursive: true, force: true })
})

test("disabled managed files keep facts DB-only", async () => {
  const { root, tools } = await setup()
  await tools.hw_memory_add.execute({
    content: "a gotcha that should stay hidden in the database",
    kind: "gotcha",
    rank: "high",
  })
  assert.ok(!existsSync(join(root, "docs", "hw-memory", "gotchas.md")))
  rmSync(root, { recursive: true, force: true })
})
