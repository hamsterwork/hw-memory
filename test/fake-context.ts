/**
 * Minimal OpenCode V2 plugin context for the unit tests and the smoke script.
 * It records tools registered through `tool.transform` and hooks registered
 * through `session.hook` / `tool.hook`, and replays events pushed with
 * `pushEvent` through `event.subscribe`.
 */

export interface FakeTool {
  name: string
  description: string
  input: Record<string, unknown>
  execute: (input: unknown, context?: unknown) => Promise<{ content?: string }>
}

export type FakeHook = (event: any) => void | Promise<void>

export interface FakeCommand {
  name: string
  description?: string
  execute: (input: { sessionID: string; prompt: { text: string }; delivery: string }) => Promise<void>
}

export interface FakePluginContext {
  ctx: any
  tools: Record<string, FakeTool>
  commands: Record<string, FakeCommand>
  hooks: Record<string, FakeHook[]>
  output: { synthetic: string[]; prompt: string[] }
  pushEvent: (event: { type: string; data: any }) => void
  callHook: (name: string, event: any) => Promise<void>
  runCommand: (name: string, text?: string) => Promise<void>
}

const registration = () => ({ dispose: async () => {} })

export function fakeContext(root: string, messages: unknown[] = []): FakePluginContext {
  const tools: Record<string, FakeTool> = {}
  const commands: Record<string, FakeCommand> = {}
  const hooks: Record<string, FakeHook[]> = {}
  const output: { synthetic: string[]; prompt: string[] } = { synthetic: [], prompt: [] }
  const queue: { type: string; data: any }[] = []
  let wake: (() => void) | undefined

  async function* stream(signal?: AbortSignal): AsyncGenerator<{ type: string; data: any }> {
    for (;;) {
      if (signal?.aborted) return
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          wake = resolve
          signal?.addEventListener("abort", () => resolve(), { once: true })
        })
        continue
      }
      yield queue.shift()!
    }
  }

  const ctx: any = {
    location: { directory: root, project: { id: "test", directory: root, canonical: root } },
    options: {},
    tool: {
      transform: async (cb: (editor: any) => void) => {
        cb({
          add: (tool: FakeTool) => {
            tools[tool.name] = tool
          },
          update: () => {},
          remove: () => {},
          get: () => undefined,
          list: () => Object.values(tools),
          namespace: () => {},
        })
        return registration()
      },
      hook: async (name: string, cb: FakeHook) => {
        ;(hooks[name] ??= []).push(cb)
        return registration()
      },
      list: async () => Object.values(tools),
    },
    command: {
      transform: async (cb: (editor: any) => void) => {
        cb({
          add: (command: FakeCommand) => {
            commands[command.name] = command
          },
          list: () => Object.values(commands),
        })
        return registration()
      },
      reload: async () => {},
      list: async () => Object.values(commands),
    },
    session: {
      context: async () => messages,
      hook: async (name: string, cb: FakeHook) => {
        ;(hooks[name] ??= []).push(cb)
        return registration()
      },
      synthetic: async ({ text }: { text: string }) => {
        output.synthetic.push(text)
        return {}
      },
      prompt: async ({ text }: { text: string }) => {
        output.prompt.push(text)
        return {}
      },
    },
    vcs: { status: async () => ({ files: [] }) },
    event: { subscribe: (options?: { signal?: AbortSignal }) => stream(options?.signal) },
    storage: {},
  }

  const callHook = async (name: string, event: any) => {
    for (const hook of hooks[name] ?? []) await hook(event)
  }

  const pushEvent = (event: { type: string; data: any }) => {
    queue.push(event)
    wake?.()
    wake = undefined
  }

  const runCommand = async (name: string, text = "") => {
    const command = commands[name]
    if (!command) throw new Error(`unknown fake command: ${name}`)
    await command.execute({ sessionID: "test-session", prompt: { text }, delivery: "steer" })
  }

  return { ctx, tools, commands, hooks, output, pushEvent, callHook, runCommand }
}

export function text(result: { content?: string }): string {
  return result.content ?? ""
}
