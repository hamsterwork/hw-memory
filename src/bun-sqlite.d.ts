declare module "bun:sqlite" {
  export class Database {
    constructor(path: string)
    exec(sql: string): void
    prepare(sql: string): any
    close(): void
  }
}
