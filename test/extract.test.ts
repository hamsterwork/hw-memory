import assert from "node:assert/strict"
import { test } from "node:test"
import {
  commandSignature,
  extractFromAssistantText,
  extractFromBash,
  firstErrorLine,
  SessionTracker,
} from "../src/extract.ts"

test("commandSignature takes first three tokens, basenames only", () => {
  assert.equal(commandSignature("npm run build"), "npm run build")
  assert.equal(commandSignature("/usr/local/bin/sqlite3 hw.db .dump"), "sqlite3 hw.db .dump")
  assert.equal(commandSignature("git  commit -m"), "git commit -m")
})

test("firstErrorLine finds last error-looking line", () => {
  const output = "Compiling...\nWaiting\nERROR: could not resolve dependency 'express'\nBuild failed"
  assert.equal(firstErrorLine(output), "Build failed")
  assert.equal(firstErrorLine("no errors here at all"), null)
})

test("extractFromBash captures failed command as error candidate", () => {
  const candidates = extractFromBash("npm run build", "Error: Cannot find module '../src/core.ts'", 1)
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].kind, "error")
  assert.equal(candidates[0].rank, "low")
  assert.match(candidates[0].content, /^npm run build: /)
  assert.match(candidates[0].content, /Cannot find module/)
})

test("extractFromBash ignores success output without patterns", () => {
  assert.deepEqual(extractFromBash("ls -la", "file1.txt\nfile2.txt", 0), [])
})

test("extractFromBash extracts dependencies on success", () => {
  const candidates = extractFromBash("npm install --save-dev vitest tsx", "added 2 packages", 0)
  assert.equal(candidates.length, 2)
  assert.ok(candidates.every((c) => c.kind === "dependency" && c.rank === "medium"))
  assert.ok(candidates.some((c) => c.content.includes("vitest")))
  const pip = extractFromBash("pip install requests", "Successfully installed requests", 0)
  assert.ok(pip.some((c) => c.content.includes("requests")))
})

test("extractFromBash skips error-candidate when exit code unknown", () => {
  assert.equal(extractFromBash("npm test", "some error happened in stream", undefined).length, 0)
})

test("extractFromAssistantText detects decision sentences en and ru", () => {
  const en = extractFromAssistantText("We reviewed the options. We'll use Postgres for the main database. Let's switch to JWT auth tokens for all endpoints.")
  assert.equal(en.length, 2)
  assert.ok(en.every((c) => c.kind === "decision" && c.rank === "medium"))
  assert.ok(en[0].content.includes("Postgres"))
  const ru = extractFromAssistantText("Обсудили варианты. Будем использовать Redis для кеша сессий. Просто текст без решений.")
  assert.equal(ru.length, 1)
  assert.ok(ru[0].content.includes("Redis"))
})

test("extractFromAssistantText skips code and long sentences", () => {
  assert.equal(extractFromAssistantText("We'll use `db.execute()` here").length, 0)
  const long = "We'll use " + "a ".repeat(150) + "thing."
  assert.equal(extractFromAssistantText(long).length, 0)
})

test("SessionTracker throttle extracts every 5th bash call", () => {
  const t = new SessionTracker()
  const results = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map(() => t.shouldExtractBash("s1"))
  assert.deepEqual(results.map((r) => (r ? 1 : 0)), [0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0])
  assert.equal(t.shouldExtractBash("s2"), false)
})

test("SessionTracker promotes only after repeated failures", () => {
  const t = new SessionTracker()
  t.noteError("s1", "npm test", 11)
  assert.equal(t.noteSuccess("s1", "npm test"), null)
  t.noteError("s1", "npm test", 12)
  t.noteError("s1", "npm test", 13)
  const promotion = t.noteSuccess("s1", "npm test")
  assert.ok(promotion)
  assert.deepEqual(promotion.errorIds.sort(), [12, 13])
  assert.equal(t.noteSuccess("s1", "npm test"), null)
})

test("SessionTracker sentence dedup per session", () => {
  const t = new SessionTracker()
  assert.equal(t.isNewSentence("s1", "We'll use Postgres for storage here"), true)
  assert.equal(t.isNewSentence("s1", "We'll use Postgres for storage here"), false)
  assert.equal(t.isNewSentence("s2", "We'll use Postgres for storage here"), true)
})
