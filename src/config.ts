import type { DB } from "./db.ts"

export type ManagedKind = "decision" | "gotcha" | "debt"

export const MANAGED_KINDS: ManagedKind[] = ["decision", "gotcha", "debt"]

export const MANAGED_DIR = "docs/hw-memory"

export const DEFAULT_TARGET_PATH: Record<ManagedKind, string> = {
  decision: `${MANAGED_DIR}/decisions.md`,
  gotcha: `${MANAGED_DIR}/gotchas.md`,
  debt: `${MANAGED_DIR}/debt.md`,
}

export interface FileTarget {
  kind: ManagedKind
  enabled: boolean
  path: string
}

export function isManagedKind(kind: string): kind is ManagedKind {
  return (MANAGED_KINDS as string[]).includes(kind)
}

export function isSafeRelPath(path: string): boolean {
  if (!path || path.startsWith("/") || path.startsWith("\\")) return false
  if (/^[A-Za-z]:[\\/]/.test(path)) return false
  return !path.replaceAll("\\", "/").split("/").includes("..")
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
