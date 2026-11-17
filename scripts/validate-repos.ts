import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openDBFile } from "../src/db.ts"
import { initSchema, searchFacts, statsFacts, wakeUpPack } from "../src/core.ts"
import { applySeed } from "../src/seed.ts"

const repos = [
  "/Users/hamsterwork/Dev/wp-wifly-modular",
  "/Users/hamsterwork/Dev/visitator-core",
]

for (const repo of repos) {
  const db = await openDBFile(join(mkdtempSync(join(tmpdir(), "hwm-val-")), "hw-memory.db"))
  initSchema(db)
  const report = applySeed(db, repo, "docs")
  console.log(`\n=== ${repo} ===`)
  console.log("seed:", `files=${report.files} blocks=${report.blocks.length} errors=${report.errors.length}`)
  console.log("stats:", JSON.stringify(statsFacts(db)))
  console.log("--- wake-up pack ---")
  console.log(wakeUpPack(db))
  for (const query of ["auth", "test suite", "медиа", "postgres"]) {
    const hits = searchFacts(db, query, { limit: 3 })
    console.log(`search "${query}":`, hits.map((h) => `[${h.rank}/${h.kind}] ${h.content.slice(0, 90)}`))
  }
  db.close()
}
