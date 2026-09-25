import { mkdirSync } from "node:fs"
import { dirname } from "node:path"

export interface Stmt {
  run(...params: unknown[]): unknown
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
}

export interface DB {
  exec(sql: string): void
  prepare(sql: string): Stmt
  close(): void
}

export async function openDBFile(path: string): Promise<DB> {
  mkdirSync(dirname(path), { recursive: true })
  let impl: any
  try {
    const mod: any = await import("bun:sqlite")
    impl = new mod.Database(path)
  } catch {
    const mod: any = await import("node:sqlite")
    impl = new mod.DatabaseSync(path)
  }
  impl.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;")
  return {
    exec: (sql: string) => impl.exec(sql),
    prepare: (sql: string) => impl.prepare(sql) as Stmt,
    close: () => impl.close(),
  }
}
