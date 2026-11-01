import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openDBFile } from "../src/db.ts"
import { initSchema } from "../src/core.ts"
import {
  DEFAULT_CAP_ROWS,
  MAX_CAP_ROWS,
  MIN_CAP_ROWS,
  getCapRows,
  setCapRows,
} from "../src/config.ts"

async function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "hwm-config-"))
  const db = await openDBFile(join(dir, "hw-memory.db"))
  initSchema(db)
  return { db, dir }
}

test("cap_rows defaults to 500", async () => {
  const { db, dir } = await fresh()
  assert.equal(DEFAULT_CAP_ROWS, 500)
  assert.equal(getCapRows(db), 500)
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

test("cap_rows round-trips and upserts one row", async () => {
  const { db, dir } = await fresh()
  assert.equal(setCapRows(db, 1500), 1500)
  assert.equal(getCapRows(db), 1500)
  assert.equal(setCapRows(db, 2000), 2000)
  assert.equal(getCapRows(db), 2000)
  const rows = db.prepare("SELECT key, value FROM settings").all() as any[]
  assert.equal(rows.length, 1)
  assert.equal(rows[0].key, "cap_rows")
  assert.equal(rows[0].value, "2000")
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

test("cap_rows rejects out-of-bounds values", async () => {
  const { db, dir } = await fresh()
  assert.throws(() => setCapRows(db, MIN_CAP_ROWS - 1), /cap_rows must be an integer/)
  assert.throws(() => setCapRows(db, MAX_CAP_ROWS + 1), /cap_rows must be an integer/)
  assert.throws(() => setCapRows(db, Number.NaN), /cap_rows must be an integer/)
  assert.equal(getCapRows(db), DEFAULT_CAP_ROWS, "a rejected value is not stored")
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

test("invalid stored cap falls back to the default", async () => {
  const { db, dir } = await fresh()
  db.prepare("INSERT INTO settings (key, value) VALUES ('cap_rows', 'not-a-number')").run()
  assert.equal(getCapRows(db), DEFAULT_CAP_ROWS)
  db.prepare("UPDATE settings SET value = '999999' WHERE key = 'cap_rows'").run()
  assert.equal(getCapRows(db), DEFAULT_CAP_ROWS)
  db.close()
  rmSync(dir, { recursive: true, force: true })
})
