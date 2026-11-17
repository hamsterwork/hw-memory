import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import HwMemoryPlugin, { HwMemoryPlugin as Named, extractSessionDecisions } from "../src/hw-memory.ts"
import { SessionTracker } from "../src/extract.ts"
import { fakeContext, text } from "./fake-context.ts"

async function setup(messages: unknown[] = []) {
  const root = mkdtempSync(join(tmpdir(), "hwm-plugin-"))
  mkdirSync(join(root, "docs"), { recursive: true })
  const fake = fakeContext(root, messages)
  const unload = await HwMemoryPlugin.setup(fake.ctx)
  const cleanup = async () => {
    await unload?.()
  }
  return { root, cleanup, ...fake }
}

const TOOL_NAMES = [
  "hw_memory_add",
  "hw_memory_search",
  "hw_memory_stats",
  "hw_memory_forget",
  "hw_memory_debt",
  "hw_memory_config",
]

const COMMAND_NAMES = [
  "hw-changes",
  "hw-seed",
  "hw-docs",
  "hw-dashboard",
  "hw-debts",
  "hw-reminders",
]

test("plugin exposes a V2 definition", async () => {
  assert.equal(HwMemoryPlugin.id, "hw-memory")
  assert.equal(typeof HwMemoryPlugin.setup, "function")
  assert.equal(Named, HwMemoryPlugin, "named and default export are the same object")
})

test("plugin registers all tools with JSON Schema input", async () => {
  const { root, tools, cleanup } = await setup()
  for (const name of TOOL_NAMES) {
    const tool = tools[name]
    assert.ok(tool, `missing tool ${name}`)
    assert.equal(typeof tool.execute, "function", `missing execute for ${name}`)
    assert.equal(tool.input.type, "object", `${name} input is a JSON Schema object`)
    assert.equal(tool.input.$schema, undefined, `${name} input drops the dialect marker`)
  }
  await cleanup()
  rmSync(root, { recursive: true, force: true })
})

test("debt flow: add warns, list shows, resolve clears the open list", async () => {
  const { root, tools, cleanup } = await setup()
  const add = text(
    await tools.hw_memory_add.execute({
      content: "unrelated serializer mismatch found while editing docs",
      kind: "debt",
      rank: "high",
    }),
  )
  assert.match(add, /Technical debt recorded/)
  const list = text(await tools.hw_memory_debt.execute({ action: "list" }))
  assert.match(list, /serializer mismatch/)
  const id = Number(list.match(/#(\d+)/)![1])
  const resolved = text(await tools.hw_memory_debt.execute({ action: "resolve", id }))
  assert.match(resolved, /Resolved/)
  assert.equal(text(await tools.hw_memory_debt.execute({ action: "list" })), "No open technical debt.")
  await cleanup()
  rmSync(root, { recursive: true, force: true })
})

test("enabling a target queues a doc update instead of writing immediately", async () => {
  const { root, tools, commands, runCommand, output, cleanup } = await setup()
  const before = text(await tools.hw_memory_config.execute({}))
  assert.match(before, /decision: disabled/)
  await tools.hw_memory_config.execute({ entity: "decision", enabled: true })
  const add = text(
    await tools.hw_memory_add.execute({
      content: "decided to keep sqlite as the only storage backend",
      kind: "decision",
      rank: "critical",
    }),
  )
  assert.match(add, /Doc update proposed/)
  assert.ok(!existsSync(join(root, "docs", "hw-memory", "decisions.md")))
  await runCommand("hw-docs")
  assert.match(output.synthetic.at(-1) ?? "", /proposals=1/)
  await runCommand("hw-docs", "--apply")
  assert.match(output.synthetic.at(-1) ?? "", /APPLIED docs/)
  assert.ok(existsSync(join(root, "docs", "hw-memory", "decisions.md")))
  assert.ok(commands["hw-docs"])
  await cleanup()
  rmSync(root, { recursive: true, force: true })
})

test("disabled managed files keep facts DB-only", async () => {
  const { root, tools, cleanup } = await setup()
  await tools.hw_memory_add.execute({
    content: "a gotcha that should stay hidden in the database",
    kind: "gotcha",
    rank: "high",
  })
  assert.ok(!existsSync(join(root, "docs", "hw-memory", "gotchas.md")))
  await cleanup()
  rmSync(root, { recursive: true, force: true })
})

test("context hook injects the wake-up pack as a system text part", async () => {
  const { root, tools, hooks, cleanup } = await setup()
  await tools.hw_memory_add.execute({ content: "postgres is the only production database", rank: "critical" })
  const event = { system: [] as { type: string; text: string }[] }
  for (const hook of hooks.context) await hook(event)
  assert.equal(event.system.length, 1)
  assert.equal(event.system[0].type, "text")
  assert.match(event.system[0].text, /postgres is the only production database/)
  await cleanup()
  rmSync(root, { recursive: true, force: true })
})

test("compaction hook injects persisted facts", async () => {
  const { root, tools, hooks, cleanup } = await setup()
  await tools.hw_memory_add.execute({ content: "the exporter drops the trailing separator token", kind: "gotcha" })
  const event = { system: [] as { type: string; text: string }[] }
  for (const hook of hooks.compaction) await hook(event)
  assert.equal(event.system.length, 1)
  assert.match(event.system[0].text, /already persisted — do not re-store them/)
  assert.match(event.system[0].text, /trailing separator token/)
  await cleanup()
  rmSync(root, { recursive: true, force: true })
})

test("bash results feed error extraction", async () => {
  const { root, tools, hooks, cleanup } = await setup()
  const event = {
    tool: "bash",
    sessionID: "s1",
    agent: "build",
    messageID: "m1",
    id: "c1",
    status: "completed",
    input: { command: "npm run build" },
    result: { content: "build started\nError: cannot find module 'left-pad'", metadata: { exitCode: 1 } },
  }
  // bash output is sampled every fifth call
  for (let i = 0; i < 5; i++) for (const hook of hooks["execute.after"]) await hook(event)
  const hits = text(await tools.hw_memory_search.execute({ query: "left-pad" }))
  assert.match(hits, /left-pad/)
  await cleanup()
  rmSync(root, { recursive: true, force: true })
})

test("session.idle stores decisions from assistant text", async () => {
  const messages = [
    { type: "user", text: "which storage?" },
    {
      type: "assistant",
      content: [
        { type: "reasoning", text: "ignore this" },
        { type: "text", text: "We'll use sqlite for the local index because it needs no server." },
      ],
    },
  ]
  const { root, tools, pushEvent, cleanup } = await setup(messages)
  pushEvent({ type: "session.idle", data: { sessionID: "s1" } })
  await new Promise((resolve) => setTimeout(resolve, 50))
  const hits = text(await tools.hw_memory_search.execute({ query: "sqlite local index" }))
  assert.match(hits, /sqlite for the local index/)
  await cleanup()
  rmSync(root, { recursive: true, force: true })
})

test("extractSessionDecisions skips non-assistant messages and repeats", async () => {
  const tracker = new SessionTracker()
  const stored: string[] = []
  const messages = [
    { type: "synthetic", text: "We'll use sqlite for the local index." },
    { type: "assistant", content: [{ type: "text", text: "We'll use sqlite for the local index because it is simple." }] },
    { type: "assistant", content: [{ type: "text", text: "We'll use sqlite for the local index because it is simple." }] },
  ]
  await extractSessionDecisions("s1", messages, tracker, (_id, candidate) => stored.push(candidate.content))
  assert.equal(stored.length, 1)
  assert.match(stored[0], /sqlite/)
})

test("config exposes and sets cap_rows", async () => {
  const { root, tools, cleanup } = await setup()
  const before = text(await tools.hw_memory_config.execute({}))
  assert.match(before, /cap_rows: 500 \(default 500\)/)

  const set = text(await tools.hw_memory_config.execute({ cap_rows: 1500 }))
  assert.match(set, /cap_rows: 1500/)

  const after = text(await tools.hw_memory_config.execute({}))
  assert.match(after, /cap_rows: 1500 \(default 500\)/)
  assert.match(after, /changelog\.source: auto/)
  assert.match(after, /changelog\.summary: deterministic/)

  assert.match(text(await tools.hw_memory_config.execute({ changelog_source: "journal" })), /changelog\.source: journal/)
  assert.match(text(await tools.hw_memory_config.execute({ changelog_summary: "ai" })), /changelog\.summary: ai/)

  const stats = text(await tools.hw_memory_stats.execute({}))
  assert.match(stats, /cap: 1500 \(default 500\)/)

  await assert.rejects(tools.hw_memory_config.execute({ cap_rows: 10 }), /cap_rows must be an integer/)
  await cleanup()
  rmSync(root, { recursive: true, force: true })
})

test("plugin registers only hw-* commands", async () => {
  const { root, commands, cleanup } = await setup()
  assert.deepEqual(Object.keys(commands).sort(), [...COMMAND_NAMES].sort())
  for (const name of COMMAND_NAMES) assert.ok(commands[name]?.description, `missing description for ${name}`)
  await cleanup()
  rmSync(root, { recursive: true, force: true })
})

test("slash commands emit deterministic reports through synthetic output", async () => {
  const { root, tools, output, runCommand, cleanup } = await setup()
  await tools.hw_memory_add.execute({
    content: "known serializer mismatch is still unresolved",
    kind: "debt",
    rank: "high",
  })
  await tools.hw_memory_add.execute({
    content: "follow up on the flaky markdown export test",
    kind: "reminder",
    rank: "medium",
  })
  writeFileSync(join(root, "notes.txt"), "[decision] Decided to keep the export format stable for compatibility.\n")

  await runCommand("hw-debts")
  assert.match(output.synthetic.at(-1) ?? "", /serializer mismatch/)
  await runCommand("hw-reminders")
  assert.match(output.synthetic.at(-1) ?? "", /flaky markdown export/)
  await runCommand("hw-dashboard")
  assert.match(output.synthetic.at(-1) ?? "", /hw-memory dashboard/)
  await runCommand("hw-docs")
  assert.match(output.synthetic.at(-1) ?? "", /DRY-RUN docs/)
  await runCommand("hw-seed", "notes.txt")
  assert.match(output.synthetic.at(-1) ?? "", /DRY-RUN seed notes\.txt/)
  await runCommand("hw-changes", "--source journal --no-save")
  assert.match(output.synthetic.at(-1) ?? "", /Changes since/)

  assert.equal(output.prompt.length, 0, "deterministic commands must not call a model")
  await cleanup()
  rmSync(root, { recursive: true, force: true })
})

test("hw-changes --ai prompts the model and still emits deterministic bullets", async () => {
  const { root, output, runCommand, cleanup } = await setup()
  await runCommand("hw-changes", "--source journal --no-save --ai")
  assert.equal(output.prompt.length, 1)
  assert.match(output.prompt[0], /Rewrite this change list/)
  assert.match(output.synthetic.at(-1) ?? "", /Changes since/)
  await cleanup()
  rmSync(root, { recursive: true, force: true })
})

test("cleanup unloads the plugin and closes the database", async () => {
  const { root, cleanup } = await setup()
  await cleanup()
  assert.ok(existsSync(join(root, ".opencode", "hw-memory.db")))
  rmSync(root, { recursive: true, force: true })
})
