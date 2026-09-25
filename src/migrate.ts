import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { DB } from "./db.ts"
import { seedFromDocs, type SeedReport } from "./docs.ts"
import { isDir, isFile } from "./fs.ts"
import { todayISO } from "./util.ts"

export interface MigrateReport {
  apply: boolean
  memoryDirFound: boolean
  copied: { from: string; to: string; merged: boolean }[]
  renumbered: boolean
  reviewManually: string[]
  agentsUpdated: boolean
  seed: SeedReport | null
}

interface Mapping {
  from: string
  to: string
  renumber?: boolean
}

const FILE_MAP: Mapping[] = [
  { from: ".memory/history/decisions.md", to: "docs/decisions.md", renumber: true },
  { from: ".memory/ai/gotchas.md", to: "docs/gotchas.md" },
  { from: ".memory/ai/context.md", to: "docs/context.md" },
  { from: ".memory/history/changelog.md", to: "docs/Changelog.md" },
]

function maxDecisionNumber(text: string): number {
  let max = 0
  for (const m of text.matchAll(/^(\d+)[.)]\s+/gm)) max = Math.max(max, Number(m[1]))
  return max
}

function renumberTopLevel(text: string, start: number): string {
  let n = start
  return text.replace(/^(\d+)[.)](\s+)/gm, () => `${++n}. `)
}

function appendMerged(target: string, source: string, renumber: boolean): string {
  const base = target.endsWith("\n") ? target : target + "\n"
  let body = source.trim()
  if (renumber) body = renumberTopLevel(body, maxDecisionNumber(target))
  return `${base}\n## Migrated from .memory (${todayISO()})\n\n${body}\n`
}

export function migrateMemoryDir(db: DB, root: string, apply = false): MigrateReport {
  const report: MigrateReport = {
    apply,
    memoryDirFound: isDir(join(root, ".memory")),
    copied: [],
    renumbered: false,
    reviewManually: [],
    agentsUpdated: false,
    seed: null,
  }
  if (!report.memoryDirFound) return report
  const actions: { from: string; to: string; merged: boolean; renumber?: boolean }[] = []
  for (const m of FILE_MAP) {
    const fromAbs = join(root, m.from)
    if (isFile(fromAbs)) {
      const targetAbs = join(root, m.to)
      const merged = isFile(targetAbs)
      actions.push({ from: m.from, to: m.to, merged, renumber: m.renumber && merged })
    }
  }
  const rolesDir = join(root, ".memory", "roles")
  if (isDir(rolesDir)) {
    for (const entry of readdirSync(rolesDir) as string[]) {
      if (!entry.endsWith(".md")) continue
      actions.push({ from: `.memory/roles/${entry}`, to: `docs/roles/${entry}`, merged: isFile(join(root, "docs", "roles", entry)) })
    }
  }
  const memoryDir = join(root, ".memory")
  for (const entry of readdirSync(memoryDir, { recursive: true }) as string[]) {
    if (!entry.endsWith(".md")) continue
    const rel = entry.replaceAll("\\", "/")
    if (FILE_MAP.some((m) => m.from === `.memory/${rel}`)) continue
    if (rel.startsWith("roles/")) continue
    if (rel === "index.md") {
      report.reviewManually.push(".memory/index.md")
      continue
    }
    actions.push({ from: `.memory/${rel}`, to: `docs/memory/${rel}`, merged: isFile(join(root, "docs", "memory", rel)) })
  }
  const agentsAbs = join(root, "AGENTS.md")
  const agentsText = isFile(agentsAbs) ? readFileSync(agentsAbs, "utf8") : ""
  report.agentsUpdated = !/^##\s+Documentation\b/m.test(agentsText)
  if (apply) {
    for (const a of actions) {
      const fromAbs = join(root, a.from)
      const toAbs = join(root, a.to)
      mkdirSync(dirname(toAbs), { recursive: true })
      const source = readFileSync(fromAbs, "utf8")
      if (a.merged) {
        writeFileSync(toAbs, appendMerged(readFileSync(toAbs, "utf8"), source, a.renumber ?? false))
        if (a.renumber) report.renumbered = true
      } else {
        writeFileSync(toAbs, source)
      }
      report.copied.push({ from: a.from, to: a.to, merged: a.merged })
    }
    if (report.agentsUpdated) {
      const docLinks = ["docs/decisions.md", "docs/gotchas.md", "docs/Changelog.md", "docs/context.md", "docs/roles"]
        .filter((rel) => existsSync(join(root, rel)))
        .map((rel) => `- [${rel}](./${rel})`)
        .join("\n")
      const section = `\n## Documentation\n\n${docLinks}\n`
      writeFileSync(agentsAbs, (agentsText.endsWith("\n") ? agentsText : agentsText + "\n") + section)
    }
    report.reviewManually.push(".memory (remove manually after review)")
    report.seed = seedFromDocs(db, root)
  } else {
    for (const a of actions) report.copied.push({ from: a.from, to: a.to, merged: a.merged })
  }
  return report
}
