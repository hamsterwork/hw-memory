import assert from "node:assert/strict"
import { test } from "node:test"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { DB } from "../src/db.ts"
import { openDBFile } from "../src/db.ts"
import { getFact, initSchema } from "../src/core.ts"
import type { ChangeAnchor } from "../src/changelog.ts"
import {
  collectChanges,
  exportChangelog,
  listCheckpoints,
  resolveAnchor,
  saveChangelogFact,
} from "../src/changelog.ts"

async function fresh(): Promise<{ dir: string; db: DB }> {
  const dir = mkdtempSync(join(tmpdir(), "hwm-changelog-"))
  const db = await openDBFile(join(dir, ".opencode", "hw-memory.db"))
  initSchema(db)
  return { dir, db }
}

function cleanup(dir: string, db: DB): () => void {
  return () => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

function addEvent(db: DB, summary: string): void {
  db.prepare("INSERT INTO change_events (created_at, source, summary) VALUES (?, 'auto', ?)").run(
    new Date().toISOString(),
    summary,
  )
}

function gitAvailable(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

function gitRun(dir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: dir, stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" })
}

function initRepo(dir: string): void {
  gitRun(dir, ["init", "-q"])
  gitRun(dir, ["config", "user.email", "test@example.com"])
  gitRun(dir, ["config", "user.name", "Test"])
  writeFileSync(join(dir, "README.md"), "hello\n")
  gitRun(dir, ["add", "README.md"])
  gitRun(dir, ["commit", "-q", "-m", "chore: scaffold project"])
  writeFileSync(join(dir, "AUTH.md"), "auth\n")
  gitRun(dir, ["add", "AUTH.md"])
  gitRun(dir, ["commit", "-q", "-m", "feat(auth): refresh tokens"])
}

function commitFile(dir: string, name: string, message: string): void {
  writeFileSync(join(dir, name), `${name}\n`)
  gitRun(dir, ["add", name])
  gitRun(dir, ["commit", "-q", "-m", message])
}

test("no-git directory falls back to a journal anchor", async (t) => {
  const { dir, db } = await fresh()
  t.after(cleanup(dir, db))
  addEvent(db, "first recorded change")

  const anchor = resolveAnchor(db, dir)
  assert.equal(anchor.source, "journal")
  assert.equal(anchor.label, "beginning")
  assert.equal(anchor.journalSeq, 0)
  assert.equal(anchor.commitSha, null)

  const report = collectChanges(db, dir, undefined, { source: "journal", save: false })
  assert.equal(report.source, "journal")
  assert.ok(report.bullets.some((b) => b.includes("first recorded change")))
})

test("version anchor resolves from stored checkpoints", async (t) => {
  const { dir, db } = await fresh()
  t.after(cleanup(dir, db))
  db.prepare(
    "INSERT INTO version_checkpoints (label, commit_sha, journal_seq, created_at) VALUES (?, NULL, ?, ?)",
  ).run("1.2.3", 12, new Date().toISOString())
  db.prepare(
    "INSERT INTO version_checkpoints (label, commit_sha, journal_seq, created_at) VALUES (?, ?, NULL, ?)",
  ).run("2.0.0", "abc1234def", new Date().toISOString())

  const journalAnchor = resolveAnchor(db, dir, "v1.2.3", "journal")
  assert.equal(journalAnchor.label, "1.2.3")
  assert.equal(journalAnchor.source, "journal")
  assert.equal(journalAnchor.journalSeq, 12)
  assert.equal(journalAnchor.commitSha, null)

  const gitAnchor = resolveAnchor(db, dir, "2.0.0", "journal")
  assert.equal(gitAnchor.source, "git")
  assert.equal(gitAnchor.commitSha, "abc1234def")
})

test("journal bullets normalize whitespace, dedupe and cap at 30", async (t) => {
  const { dir, db } = await fresh()
  t.after(cleanup(dir, db))
  for (let i = 0; i < 35; i++) addEvent(db, `change number ${i}`)
  addEvent(db, "change  number   0")

  const report = collectChanges(db, dir, undefined, { source: "journal", save: false })
  assert.equal(report.source, "journal")
  assert.equal(report.count, 31)
  assert.equal(report.bullets[0], "- change number 0")
  assert.ok(report.bullets.at(-1)!.includes("and 5 more changes"))
  assert.equal(report.bullets.filter((b) => b.startsWith("- ")).length, 31)
})

test("collectChanges saves by default and skips the empty placeholder", async (t) => {
  const { dir, db } = await fresh()
  t.after(cleanup(dir, db))

  const empty = collectChanges(db, dir, undefined, { source: "journal" })
  assert.deepEqual(empty.bullets, ["- No recorded changes since beginning."])
  assert.equal(empty.savedId, null)

  addEvent(db, "a real change")
  const saved = collectChanges(db, dir, undefined, { source: "journal" })
  assert.ok(saved.savedId !== null)
  const fact = getFact(db, saved.savedId!)
  assert.ok(fact)
  assert.equal(fact.kind, "changelog")
})

test("saveChangelogFact stores a changelog fact and a checkpoint", async (t) => {
  const { dir, db } = await fresh()
  t.after(cleanup(dir, db))
  const anchor: ChangeAnchor = { label: "3.0.0", commitSha: null, journalSeq: 7, source: "journal" }

  const id = saveChangelogFact(db, anchor, ["- first change", "- second change"])
  const fact = getFact(db, id)
  assert.ok(fact)
  assert.equal(fact.kind, "changelog")
  assert.equal(fact.rank, "medium")
  assert.equal(fact.source, "auto")
  assert.equal(fact.origin, "changes:3.0.0..HEAD")
  assert.equal(fact.content, "- first change\n- second change")

  const checkpoints = listCheckpoints(db)
  assert.equal(checkpoints.length, 1)
  assert.equal(checkpoints[0]!.label, "3.0.0")
  assert.equal(checkpoints[0]!.journalSeq, 7)
  assert.equal(checkpoints[0]!.commitSha, null)

  // Beginning anchors never produce a version checkpoint.
  saveChangelogFact(db, { label: "beginning", commitSha: null, journalSeq: 0, source: "journal" }, ["- early change"])
  assert.equal(listCheckpoints(db).length, 1)
})

test("exportChangelog writes a clean markdown file", async (t) => {
  const { dir, db } = await fresh()
  t.after(cleanup(dir, db))
  saveChangelogFact(
    db,
    { label: "1.0.0", commitSha: "abc1234", journalSeq: null, source: "git" },
    ["- feat: shipped thing (abc1234)"],
  )
  saveChangelogFact(
    db,
    { label: "2.0.0", commitSha: null, journalSeq: 3, source: "journal" },
    ["- fix: patched thing (def5678)"],
  )

  const rel = exportChangelog(db, dir)
  assert.equal(rel, "docs/hw-memory/changelog.md")
  const text = readFileSync(join(dir, rel), "utf8")
  assert.ok(text.startsWith("# Changelog\n"))
  assert.ok(text.includes("## 1.0.0"))
  assert.ok(text.includes("## 2.0.0"))
  assert.ok(text.includes("- feat: shipped thing (abc1234)"))
  assert.ok(text.includes("- fix: patched thing (def5678)"))
  assert.ok(!text.includes("changes:"))
  assert.ok(!text.includes("<!--"))
  assert.ok(!/\bID\b/.test(text))
})

test("invalid version labels are rejected before any git call", async (t) => {
  const { dir, db } = await fresh()
  t.after(cleanup(dir, db))
  for (const bad of ["1.0.0; echo pwned", "../secret", "v1.0.0 && rm -rf .", "", "a".repeat(65)]) {
    assert.throws(() => resolveAnchor(db, dir, bad), /Invalid version label/)
  }
})

test("ai flag adds only a text prefix and preserves deterministic bullets", async (t) => {
  const { dir, db } = await fresh()
  t.after(cleanup(dir, db))
  addEvent(db, "alpha change")
  addEvent(db, "beta change")

  const det = collectChanges(db, dir, undefined, { source: "journal", save: false, summary: "deterministic" })
  const ai = collectChanges(db, dir, undefined, { source: "journal", save: false, summary: "ai" })
  assert.deepEqual(ai.bullets, det.bullets)
  assert.equal(det.text, det.bullets.join("\n"))
  assert.equal(ai.text, `AI summarization requested; deterministic bullets below.\n${det.bullets.join("\n")}`)
})

test("git mode collects and formats commits from a temporary repository", async (t) => {
  if (!gitAvailable()) {
    t.skip("git is not available")
    return
  }
  const { dir, db } = await fresh()
  t.after(cleanup(dir, db))
  initRepo(dir)
  const rootSha = gitRun(dir, ["rev-list", "--max-parents=0", "HEAD"]).trim()
  const featSha = gitRun(dir, ["rev-parse", "HEAD"]).trim()
  gitRun(dir, ["tag", "v0.1.0"])
  commitFile(dir, "a.txt", "fix: correct the bug")

  const anchor = resolveAnchor(db, dir)
  assert.equal(anchor.source, "git")
  assert.equal(anchor.commitSha, rootSha)

  const report = collectChanges(db, dir, undefined, { save: false })
  assert.equal(report.source, "git")
  assert.ok(report.bullets.some((b) => b.includes("feat(auth): refresh tokens")))
  assert.ok(report.bullets.some((b) => b.includes("fix: correct the bug")))
  assert.ok(report.bullets.some((b) => /refresh tokens \([0-9a-f]+\)/.test(b)))
  const featIdx = report.bullets.findIndex((b) => b.includes("feat(auth)"))
  const fixIdx = report.bullets.findIndex((b) => b.includes("fix:"))
  assert.ok(featIdx >= 0 && fixIdx >= 0 && featIdx < fixIdx, "conventional commits are grouped by type")

  const tagged = resolveAnchor(db, dir, "0.1.0")
  assert.equal(tagged.source, "git")
  assert.equal(tagged.commitSha, featSha)

  const ranged = collectChanges(db, dir, "0.1.0", { save: false })
  assert.equal(ranged.bullets.length, 1)
  assert.ok(ranged.bullets[0]!.includes("fix: correct the bug"))
  assert.ok(!ranged.bullets.some((b) => b.includes("refresh tokens")))

  const withUncommitted = collectChanges(db, dir, "0.1.0", { save: false, uncommitted: ["local edit one", "local edit two"] })
  assert.ok(withUncommitted.bullets.includes("## Uncommitted"))
  assert.ok(withUncommitted.bullets.includes("- local edit one"))
  assert.ok(withUncommitted.bullets.includes("- local edit two"))
})
