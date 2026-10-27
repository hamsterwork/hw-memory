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

export interface FakePluginContext {
  ctx: any
  tools: Record<string, FakeTool>
  hooks: Record<string, FakeHook[]>
  pushEvent: (event: { type: string; data: any }) => void
  callHook: (name: string, event: any) => Promise<void>
}

const registration = () => ({ dispose: async () => {} })

export function fakeContext(root: string, messages: unknown[] = []): FakePluginContext {
  const tools: Record<string, FakeTool> = {}
  const hooks: Record<string, FakeHook[]> = {}
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
    session: {
      context: async () => messages,
      hook: async (name: string, cb: FakeHook) => {
        ;(hooks[name] ??= []).push(cb)
        return registration()
      },
    },
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

  return { ctx, tools, hooks, pushEvent, callHook }
}

export function text(result: { content?: string }): string {
  return result.content ?? ""
}
