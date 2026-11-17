import type { DB } from "./db.ts"
import {
  changesOperation,
  dashboardOperation,
  debtsOperation,
  docsOperation,
  remindersOperation,
  seedOperation,
  type CommandArgs,
} from "./ops.ts"

export const COMMAND_NAMES = [
  "hw-changes",
  "hw-seed",
  "hw-docs",
  "hw-dashboard",
  "hw-debts",
  "hw-reminders",
] as const

export type CommandName = (typeof COMMAND_NAMES)[number]

export function parseCommandArgs(raw: string, name?: string): CommandArgs {
  let text = raw.trim()
  if (name) {
    const prefixed = `/${name}`
    if (text.startsWith(prefixed)) text = text.slice(prefixed.length).trim()
    else if (text.startsWith(name)) text = text.slice(name.length).trim()
  }
  const positional: string[] = []
  const flags: Record<string, string | boolean> = {}
  for (const token of text.split(/\s+/).filter(Boolean)) {
    if (!token.startsWith("--")) {
      positional.push(token)
      continue
    }
    const eq = token.indexOf("=")
    if (eq > 0) flags[token.slice(0, eq)] = token.slice(eq + 1)
    else flags[token] = true
  }
  return { positional, flags }
}

type Runner = (args: CommandArgs, ctx: any) => Promise<{ text: string; aiPrompt?: string }>

const runners: Record<CommandName, Runner> = {
  "hw-changes": async (args, ctx) => {
    let uncommitted: string[] = []
    try {
      const status = await ctx.vcs.status()
      const files = (status as any)?.data ?? (status as any)?.files ?? (status as any)?.changes ?? []
      uncommitted = Array.isArray(files)
        ? files.map((f: any) => `${f.status ?? "changed"}: ${f.path ?? f.file ?? JSON.stringify(f)}`)
        : []
    } catch {
      uncommitted = []
    }
    return changesOperation(ctx.__db, ctx.__root, args, uncommitted)
  },
  "hw-seed": async (args, ctx) => ({ text: seedOperation(ctx.__db, ctx.__root, args) }),
  "hw-docs": async (args, ctx) => ({ text: docsOperation(ctx.__db, ctx.__root, args) }),
  "hw-dashboard": async (args, ctx) => ({ text: dashboardOperation(ctx.__db, ctx.__root, args) }),
  "hw-debts": async (args, ctx) => ({ text: debtsOperation(ctx.__db) }),
  "hw-reminders": async (args, ctx) => ({ text: remindersOperation(ctx.__db) }),
}

const descriptions: Record<CommandName, string> = {
  "hw-changes": "Show a human-readable list of project changes since a version/checkpoint.",
  "hw-seed": "Seed memory from a file or folder. Dry-run by default; --apply commits.",
  "hw-docs": "Review and write proposed doc updates; report drift in seeded files.",
  "hw-dashboard": "Show top debts, reminders, prune proposals and pending doc updates.",
  "hw-debts": "List all open technical debt by current weight.",
  "hw-reminders": "List all reminders by current weight.",
}

export async function registerCommands(ctx: any, db: DB, root: string): Promise<void> {
  const scoped: any = Object.create(ctx)
  scoped.__db = db
  scoped.__root = root
  await ctx.command.transform((editor: any) => {
    for (const name of COMMAND_NAMES) {
      editor.add({
        name,
        description: descriptions[name],
        execute: async ({ sessionID, prompt, delivery }: any) => {
          const args = parseCommandArgs(prompt?.text ?? "", name)
          const result = await runners[name](args, scoped)
          if (result.aiPrompt) {
            await ctx.session.prompt({ ...prompt, sessionID, text: result.aiPrompt, delivery })
            await ctx.session.synthetic({ sessionID, text: result.text })
          } else {
            await ctx.session.synthetic({ sessionID, text: result.text })
          }
        },
      })
    }
  })
}
