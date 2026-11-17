import type { DB } from "./db.ts"

export type ChangelogSourceSetting = "auto" | "git" | "journal"
export type ChangelogSummarySetting = "deterministic" | "ai"

export const DEFAULT_CHANGELOG_SOURCE: ChangelogSourceSetting = "auto"
export const DEFAULT_CHANGELOG_SUMMARY: ChangelogSummarySetting = "deterministic"

export type ManagedKind = "decision" | "gotcha" | "debt" | "reminder" | "changelog"

export const MANAGED_KINDS: ManagedKind[] = ["decision", "gotcha", "debt", "reminder", "changelog"]

export const MANAGED_DIR = "docs/hw-memory"

export const DEFAULT_TARGET_PATH: Record<ManagedKind, string> = {
  decision: `${MANAGED_DIR}/decisions.md`,
  gotcha: `${MANAGED_DIR}/gotchas.md`,
  debt: `${MANAGED_DIR}/debt.md`,
  reminder: `${MANAGED_DIR}/reminders.md`,
  changelog: `${MANAGED_DIR}/changelog.md`,
}

export interface FileTarget {
  kind: ManagedKind
  enabled: boolean
  path: string
}

export function isManagedKind(kind: string): kind is ManagedKind {
  return (MANAGED_KINDS as string[]).includes(kind)
}

export function ensureFileTargets(db: DB): void {
  for (const kind of MANAGED_KINDS) {
    db.prepare("INSERT OR IGNORE INTO file_targets (kind, enabled, path) VALUES (?, 0, ?)").run(
      kind,
      DEFAULT_TARGET_PATH[kind],
    )
  }
}

export function getTarget(db: DB, kind: ManagedKind): FileTarget {
  const r = db.prepare("SELECT kind, enabled, path FROM file_targets WHERE kind = ?").get(kind) as any
  if (!r) return { kind, enabled: false, path: DEFAULT_TARGET_PATH[kind] }
  return { kind, enabled: (r.enabled as number) !== 0, path: r.path as string }
}

export function setTarget(db: DB, kind: ManagedKind, patch: { enabled?: boolean; path?: string }): FileTarget {
  const current = getTarget(db, kind)
  const enabled = patch.enabled ?? current.enabled
  const path = patch.path ?? current.path
  db.prepare("UPDATE file_targets SET enabled = ?, path = ? WHERE kind = ?").run(enabled ? 1 : 0, path, kind)
  return { kind, enabled, path }
}

export function listTargets(db: DB): FileTarget[] {
  return MANAGED_KINDS.map((kind) => getTarget(db, kind))
}

/** Facts kept per project DB when no `cap_rows` setting is stored. */
export const DEFAULT_CAP_ROWS = 500

export const MIN_CAP_ROWS = 50

export const MAX_CAP_ROWS = 100_000

const CAP_ROWS_KEY = "cap_rows"

/** Effective cap for this project: stored setting inside bounds, else the default. */
export function getCapRows(db: DB): number {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(CAP_ROWS_KEY) as any
  const value = row ? Number.parseInt(String(row.value), 10) : Number.NaN
  if (!Number.isFinite(value) || value < MIN_CAP_ROWS || value > MAX_CAP_ROWS) return DEFAULT_CAP_ROWS
  return value
}

function setSetting(db: DB, key: string, value: string): void {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value)
}

function getSetting(db: DB, key: string): string | null {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as any
  return row ? String(row.value) : null
}

/** Store the cap for this project. Throws when out of bounds. */
export function setCapRows(db: DB, value: number): number {
  const cap = Math.trunc(value)
  if (!Number.isFinite(cap) || cap < MIN_CAP_ROWS || cap > MAX_CAP_ROWS) {
    throw new Error(`cap_rows must be an integer between ${MIN_CAP_ROWS} and ${MAX_CAP_ROWS}`)
  }
  setSetting(db, CAP_ROWS_KEY, String(cap))
  return cap
}

export function getChangelogSource(db: DB): ChangelogSourceSetting {
  const value = getSetting(db, "changelog.source")
  return value === "git" || value === "journal" || value === "auto" ? value : DEFAULT_CHANGELOG_SOURCE
}

export function setChangelogSource(db: DB, value: string): ChangelogSourceSetting {
  if (value !== "auto" && value !== "git" && value !== "journal") {
    throw new Error("changelog.source must be auto, git or journal")
  }
  setSetting(db, "changelog.source", value)
  return value
}

export function getChangelogSummary(db: DB): ChangelogSummarySetting {
  const value = getSetting(db, "changelog.summary")
  return value === "ai" || value === "deterministic" ? value : DEFAULT_CHANGELOG_SUMMARY
}

export function setChangelogSummary(db: DB, value: string): ChangelogSummarySetting {
  if (value !== "deterministic" && value !== "ai") {
    throw new Error("changelog.summary must be deterministic or ai")
  }
  setSetting(db, "changelog.summary", value)
  return value
}
