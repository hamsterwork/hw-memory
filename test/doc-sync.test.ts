import assert from "node:assert/strict"
import { test } from "node:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { DB } from "../src/db.ts"
import { openDBFile } from "../src/db.ts"
import { addFact, initSchema, markObsolete, resolveFact } from "../src/core.ts"
import { contentHash } from "../src/util.ts"
import {
  applyDocs,
  listDocUpdates,
  noteToolFileChange,
  planDocs,
  queueDocUpdate,
  renderDocs,
  scanDrift,
} from "../src/doc-sync.ts"

const DECISIONS = "docs/hw-memory/decisions.md"
const GOTCHAS = "docs/hw-memory/gotchas.md"
const DEBT = "docs/hw-memory/debt.md"
const REMINDERS = "docs/hw-memory/reminders.md"

interface Fixture {
  root: string
  db: DB
  cleanup: () => void
}

async function fixture(files: Record<string, string> = {}): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "hwm-docsync-"))
  for (const [rel, text] of Object.entries(files)) {
    const abs = join(root, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, text)
  }
  const db = await openDBFile(join(root, ".opencode", "hw-memory.db"))
  initSchema(db)
  db.prepare("UPDATE file_targets SET enabled = 1").run()
  return { root, db, cleanup: () => { db.close(); rmSync(root, { recursive: true, force: true }) } }
}

function read(root: string, rel: string): string {
  return readFileSync(join(root, rel), "utf8")
}

function insertScope(
  db: DB,
  path: string,
  opts: {
    kind?: string
    hash?: string
    lineHashes?: string[]
    files?: number
    seededAt?: string
  } = {},
): void {
  db.prepare(
    `INSERT INTO seed_scopes
       (path, kind, last_seen_hash, last_seeded_hash, files, line_hashes, last_seeded_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    path,
    opts.kind ?? "file",
    opts.hash ?? "",
    opts.hash ?? "",
    opts.files ?? 0,
    JSON.stringify(opts.lineHashes ?? []),
    opts.seededAt ?? null,
    "2026-01-01T00:00:00.000Z",
  )
}

test("queueDocUpdate dedupes identical pending rows", async () => {
  const f = await fixture()
  try {
    const content = "Always run the full parser suite before tagging a release"
    const fact = addFact(f.db, { content, kind: "decision", rank: "critical", source: "agent" })
    const queued = {
      id: fact.id,
      kind: "decision" as const,
      content,
      origin: null,
    }
    assert.equal(queueDocUpdate(f.db, queued), true)
    assert.equal(queueDocUpdate(f.db, queued), false)
    const rows = listDocUpdates(f.db)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].factId, fact.id)
    assert.equal(rows[0].file, DECISIONS)
    assert.equal(rows[0].heading, "Decision")
    assert.equal(rows[0].reason, "new crucial fact")
    assert.equal(
      queueDocUpdate(f.db, queued, "docs/custom.md", "Custom", "another reason"),
      true,
      "a different target file is a different update",
    )
    assert.equal(listDocUpdates(f.db).length, 2)
  } finally {
    f.cleanup()
  }
})

test("renderDocs emits clean markdown without ids, markers or origins", async () => {
  const f = await fixture()
  try {
    const decision = addFact(f.db, {
      content: "Use PostgreSQL for the main database",
      keywords: ["postgres", "database"],
      kind: "decision",
      rank: "critical",
      source: "agent",
      origin: "agent://session#12",
    })
    addFact(f.db, {
      content: "Run the full suite when the grammar parser changes",
      kind: "decision",
      rank: "high",
      source: "agent",
    })
    addFact(f.db, {
      content: "sqlite locking under parallel workers needs a retry",
      keywords: ["sqlite", "locking"],
      kind: "debt",
      rank: "high",
      source: "agent",
    })
    const docs = renderDocs(f.db)
    assert.deepEqual(Object.keys(docs).sort(), [
      DECISIONS,
      GOTCHAS,
      DEBT,
      "docs/hw-memory/changelog.md",
      "docs/hw-memory/reminders.md",
    ].sort())
    const decisions = docs[DECISIONS]
    assert.ok(decisions.startsWith("# Decisions\n"))
    assert.ok(decisions.includes("## Postgres"))
    assert.ok(decisions.includes("Use PostgreSQL for the main database"))
    const debt = docs[DEBT]
    assert.ok(debt.includes("[high] sqlite locking under parallel workers needs a retry"))
    for (const text of Object.values(docs)) {
      assert.ok(!text.includes(`#${decision.id}`), "no internal fact ids")
      assert.ok(!text.includes("<!--"), "no HTML markers")
      assert.ok(!text.includes("src:"), "no origin strings")
      assert.ok(!text.includes("agent://"), "no origin strings")
    }
  } finally {
    f.cleanup()
  }
})

test("planDocs previews without writing and applyDocs creates and appends files", async () => {
  const f = await fixture()
  try {
    const firstContent = "Decisions about alpha are recorded first"
    const secondContent = "Decisions about beta are recorded second"
    const first = addFact(f.db, { content: firstContent, kind: "decision", rank: "critical", source: "agent" })
    const second = addFact(f.db, { content: secondContent, kind: "decision", rank: "high", source: "agent" })
    queueDocUpdate(f.db, { id: first.id, kind: "decision", content: firstContent, origin: null }, undefined, "Rules")
    queueDocUpdate(f.db, { id: second.id, kind: "decision", content: secondContent, origin: null }, undefined, "Notes")

    const plan = planDocs(f.db, f.root)
    assert.equal(plan.proposals.length, 2)
    assert.deepEqual(plan.writes, [{ file: DECISIONS, added: 2 }])
    assert.equal(existsSync(join(f.root, DECISIONS)), false, "planDocs must not write")

    const applied = applyDocs(f.db, f.root)
    assert.equal(applied.proposals.length, 2)
    assert.equal(applied.writes[0].added, 2)
    const text = read(f.root, DECISIONS)
    assert.ok(text.startsWith("# Decisions"))
    assert.ok(text.includes("## Rules"))
    assert.ok(text.includes("## Notes"))
    assert.ok(text.includes("Decisions about alpha are recorded first"))
    assert.ok(text.includes("Decisions about beta are recorded second"))
    assert.ok(text.indexOf("alpha") < text.indexOf("beta"))
    assert.equal(listDocUpdates(f.db).length, 0)

    const manifest = f.db.prepare("SELECT fact_id, file, line_hash, owner FROM doc_manifest ORDER BY fact_id").all() as any[]
    assert.equal(manifest.length, 2)
    assert.equal(manifest[0].owner, "plugin")
    assert.equal(manifest[0].file, DECISIONS)
    const writtenLine = text.split("\n").find((line) => line.includes("alpha"))!
    assert.equal(manifest[0].line_hash, contentHash(writtenLine))

    const again = applyDocs(f.db, f.root)
    assert.equal(again.proposals.length, 0)
    assert.equal(read(f.root, DECISIONS).split("\n").filter((l) => l.includes("alpha")).length, 1)
  } finally {
    f.cleanup()
  }
})

test("applyDocs with ids writes only the selected proposals", async () => {
  const f = await fixture()
  try {
    const alpha = "Selective write alpha decision"
    const beta = "Selective write beta decision"
    const a = addFact(f.db, { content: alpha, kind: "decision", source: "agent" })
    const b = addFact(f.db, { content: beta, kind: "decision", source: "agent" })
    queueDocUpdate(f.db, { id: a.id, kind: "decision", content: alpha, origin: null })
    queueDocUpdate(f.db, { id: b.id, kind: "decision", content: beta, origin: null })
    applyDocs(f.db, f.root, [a.id])
    let text = read(f.root, DECISIONS)
    assert.ok(text.includes(alpha))
    assert.ok(!text.includes(beta))
    assert.deepEqual(listDocUpdates(f.db).map((r) => r.factId), [b.id])
    applyDocs(f.db, f.root)
    text = read(f.root, DECISIONS)
    assert.ok(text.includes(beta))
  } finally {
    f.cleanup()
  }
})

test("safe writer preserves user prose in an existing managed file", async () => {
  const f = await fixture({
    [GOTCHAS]: "# Gotchas\n\n## Notes\n\n- A user-authored line that must survive every sync.\n",
  })
  try {
    const content = "A plugin-authored pitfall about stale cache invalidation"
    const fact = addFact(f.db, { content, kind: "gotcha", rank: "high", source: "agent" })
    queueDocUpdate(f.db, { id: fact.id, kind: "gotcha", content, origin: null }, undefined, "Notes")
    applyDocs(f.db, f.root)
    const text = read(f.root, GOTCHAS)
    assert.ok(text.includes("- A user-authored line that must survive every sync."))
    assert.ok(text.includes(content))
    assert.ok(text.indexOf("user-authored") < text.indexOf(content))
  } finally {
    f.cleanup()
  }
})

test("scanDrift detects added, removed and changed lines without updating scopes", async () => {
  const f = await fixture()
  try {
    const rel = "docs/notes.md"
    const before = [
      "alpha line remains",
      "beta line changes",
      "gamma line disappears",
      "middle anchor",
      "omega anchor",
    ]
    mkdirSync(dirname(join(f.root, rel)), { recursive: true })
    writeFileSync(join(f.root, rel), `${before.join("\n")}\n`)
    insertScope(f.db, rel, {
      hash: contentHash(before.join("\n")),
      lineHashes: before.map(contentHash),
      files: 1,
      seededAt: "2026-01-01T00:00:00.000Z",
    })
    assert.deepEqual(scanDrift(f.db, f.root), [], "unchanged file has no drift")

    const after = [
      "alpha line remains",
      "delta line appears",
      "middle anchor",
      "epsilon line appears",
      "zeta line appears",
      "omega anchor",
    ]
    writeFileSync(join(f.root, rel), `${after.join("\n")}\n`)
    const drift = scanDrift(f.db, f.root)
    assert.equal(drift.length, 1)
    assert.equal(drift[0].path, rel)
    assert.equal(drift[0].changed, 1)
    assert.equal(drift[0].added, 2)
    assert.equal(drift[0].removed, 1)
    assert.equal(drift[0].agentAttributed, false)
    assert.ok(drift[0].reason.length > 0)
    const stored = f.db.prepare("SELECT last_seen_hash, line_hashes FROM seed_scopes WHERE path = ?").get(rel) as any
    assert.equal(stored.last_seen_hash, contentHash(before.join("\n")), "scanDrift must not update seed_scopes")
    assert.equal(stored.line_hashes, JSON.stringify(before.map(contentHash)))
  } finally {
    f.cleanup()
  }
})

test("scanDrift reports folder file-count deltas and agent attribution", async () => {
  const f = await fixture({
    "docs/seeds/a.md": "seed alpha content",
    "docs/seeds/b.md": "seed beta content",
  })
  try {
    const files = ["a.md", "b.md"].map((name) => `${name}\0${contentHash(read(f.root, `docs/seeds/${name}`))}`)
    const hash = contentHash(files.sort().join("\n"))
    const seededAt = "2026-01-01T00:00:00.000Z"
    insertScope(f.db, "docs/seeds", { kind: "folder", hash, files: 2, seededAt })
    assert.deepEqual(scanDrift(f.db, f.root), [])

    writeFileSync(join(f.root, "docs", "seeds", "c.md"), "seed gamma content")
    noteToolFileChange(f.db, "ses_123", "docs/seeds/c.md", "added a seed file via patch")
    const events = f.db.prepare("SELECT source, session_id, ref FROM change_events").all() as any[]
    assert.equal(events.length, 1)
    assert.equal(events[0].source, "agent-tool")
    assert.equal(events[0].session_id, "ses_123")
    assert.equal(events[0].ref, "docs/seeds/c.md")

    const drift = scanDrift(f.db, f.root)
    assert.equal(drift.length, 1)
    assert.equal(drift[0].added, 1)
    assert.equal(drift[0].removed, 0)
    assert.equal(drift[0].agentAttributed, true, "agent event under the folder attributes the drift")

    f.db.prepare("DELETE FROM change_events").run()
    f.db
      .prepare("INSERT INTO change_events (created_at, session_id, source, summary, ref) VALUES (?, ?, ?, ?, ?)")
      .run("2020-01-01T00:00:00.000Z", "old", "agent-tool", "old edit", "docs/seeds/c.md")
    assert.equal(scanDrift(f.db, f.root)[0].agentAttributed, false, "events before last_seeded_at do not attribute")
  } finally {
    f.cleanup()
  }
})

test("scanDrift attributes file drift only to matching agent-tool events", async () => {
  const f = await fixture({ "docs/seed-file.md": "original content" })
  try {
    const rel = "docs/seed-file.md"
    insertScope(f.db, rel, {
      hash: contentHash("original content"),
      lineHashes: [contentHash("original content")],
      seededAt: "2026-01-01T00:00:00.000Z",
    })
    writeFileSync(join(f.root, rel), "edited content")
    noteToolFileChange(f.db, "ses_1", "docs/other.md", "unrelated edit")
    assert.equal(scanDrift(f.db, f.root)[0].agentAttributed, false)
    noteToolFileChange(f.db, "ses_2", rel, "edited the seeded file")
    assert.equal(scanDrift(f.db, f.root)[0].agentAttributed, true)
    assert.equal(scanDrift(f.db, f.root, { force: true }).length, 1, "force never filters drift")
  } finally {
    f.cleanup()
  }
})

test("applyDocs removes an obsolete fact only while its exact line is intact", async () => {
  const f = await fixture()
  try {
    const content = "The old importer cannot handle multi-byte separator tokens"
    const fact = addFact(f.db, { content, kind: "debt", rank: "medium", source: "agent" })
    queueDocUpdate(f.db, { id: fact.id, kind: "debt", content, origin: null })
    applyDocs(f.db, f.root)
    let text = read(f.root, DEBT)
    const line = text.split("\n").find((candidate) => candidate.includes(content))!
    assert.ok(line.includes("[medium]"))

    markObsolete(f.db, fact.id)
    const plan = planDocs(f.db, f.root)
    assert.equal(plan.removals.length, 1)
    assert.equal(plan.removals[0].file, DEBT)
    assert.ok(plan.removals[0].content.includes(content))
    assert.ok(read(f.root, DEBT).includes(content), "planDocs must not remove")

    applyDocs(f.db, f.root)
    text = read(f.root, DEBT)
    assert.ok(!text.includes(content))
    assert.ok(text.startsWith("# Debt"))
    const manifest = f.db.prepare("SELECT COUNT(*) AS c FROM doc_manifest").get() as any
    assert.equal(manifest.c, 0)
  } finally {
    f.cleanup()
  }
})

test("applyDocs keeps a user-edited line and marks its manifest row as user-owned", async () => {
  const f = await fixture()
  try {
    const content = "An outdated parser rule was removed from the grammar"
    const fact = addFact(f.db, { content, kind: "gotcha", rank: "high", source: "agent" })
    queueDocUpdate(f.db, { id: fact.id, kind: "gotcha", content, origin: null })
    applyDocs(f.db, f.root)
    let text = read(f.root, GOTCHAS)
    const line = text.split("\n").find((candidate) => candidate.includes(content))!
    writeFileSync(join(f.root, GOTCHAS), text.replace(line, `${line} — kept by a human`))

    markObsolete(f.db, fact.id)
    assert.deepEqual(planDocs(f.db, f.root).removals, [], "changed line is not removable")
    applyDocs(f.db, f.root)
    text = read(f.root, GOTCHAS)
    assert.ok(text.includes(`${content} — kept by a human`))
    const manifest = f.db.prepare("SELECT owner FROM doc_manifest WHERE fact_id = ?").get(fact.id) as any
    assert.equal(manifest.owner, "user")

    applyDocs(f.db, f.root)
    assert.ok(read(f.root, GOTCHAS).includes(content), "user-owned lines stay on later applies")
  } finally {
    f.cleanup()
  }
})

test("a resolved reminder loses its doc line like any other obsolete fact", async () => {
  const f = await fixture()
  try {
    const content = "Follow up on the flaky markdown export test"
    const fact = addFact(f.db, { content, kind: "reminder", rank: "medium", source: "agent" })
    queueDocUpdate(f.db, { id: fact.id, kind: "reminder", content, origin: null })
    applyDocs(f.db, f.root)
    assert.ok(read(f.root, REMINDERS).includes(content))

    resolveFact(f.db, fact.id)
    assert.equal(planDocs(f.db, f.root).removals.length, 1)
    applyDocs(f.db, f.root)
    assert.ok(!read(f.root, REMINDERS).includes(content))
  } finally {
    f.cleanup()
  }
})
