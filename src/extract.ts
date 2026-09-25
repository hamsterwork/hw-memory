import type { Kind, Rank } from "./core.ts"
import { contentHash, truncate } from "./util.ts"

export interface Candidate {
  content: string
  kind: Kind
  rank: Rank
  keywords?: string[]
}

export function commandSignature(cmd: string): string {
  const tokens = cmd
    .trim()
    .split(/\s+/)
    .slice(0, 3)
    .map((t) => (t.includes("/") ? t.split("/").pop() ?? t : t).toLowerCase())
  return tokens.join(" ")
}

const ERROR_RE =
  /(?:\berror\b|\bfatal\b|\bcannot\b|\bnot found\b|\bno such\b|econnrefused|err_[\w.]+|\bexception\b|\btraceback\b|permission denied|\bfailed\b)/i

export function firstErrorLine(output: string): string | null {
  const lines = output.split("\n").filter((l) => l.trim().length > 0).slice(-50)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (ERROR_RE.test(line) && !/^\s*$/.test(line)) {
      return truncate(line.replace(/\s+/g, " "), 200)
    }
  }
  return null
}

const DEP_RE =
  /^(npm|yarn|pnpm|bun|pip|pip3|cargo|composer)\s+(?:[a-z]+\s+)*(?:install|i|add|require)\s+(.+)$/

export function extractFromBash(cmd: string, output: string, exitCode: number | undefined): Candidate[] {
  const out: Candidate[] = []
  const sig = commandSignature(cmd)
  if (exitCode !== undefined && exitCode !== 0 && output.length >= 20) {
    const errLine = firstErrorLine(output)
    if (errLine) {
      out.push({
        content: `${sig}: ${errLine}`,
        kind: "error",
        rank: "low",
        keywords: [sig.split(" ")[0]],
      })
    }
  }
  if (exitCode === 0 || exitCode === undefined) {
    const dep = cmd.trim().match(DEP_RE)
    if (dep) {
      const manager = dep[1]
      const pkgs = dep[2]
        .split(/\s+/)
        .filter((p) => !p.startsWith("-") && !p.startsWith("--") && p.length > 0)
        .slice(0, 5)
      for (const pkg of pkgs) {
        out.push({
          content: `Dependency ${pkg} installed via ${manager}`,
          kind: "dependency",
          rank: "medium",
          keywords: [pkg],
        })
      }
    }
  }
  return out
}

const DECISION_RE =
  /(?<![\p{L}\p{N}_])(?:we'?ll use|let'?s use|let us use|we use|switch(?:ing|ed)? to|decided to|we choose|we chose|moved to|sticking with|settled on|going with|будем использовать|будем юзать|переходим на|перешли на|выбираем|выбрали|решено|остановились на|используем)(?![\p{L}\p{N}_])/iu

export function extractFromAssistantText(text: string): Candidate[] {
  const out: Candidate[] = []
  const sentences = text.split(/(?<=[.!?…])\s+/)
  for (const raw of sentences) {
    const sentence = raw.trim().replace(/\s+/g, " ")
    if (sentence.length < 25 || sentence.length > 250) continue
    if (!DECISION_RE.test(sentence)) continue
    if (/[`{}<>]/.test(sentence)) continue
    out.push({ content: truncate(sentence, 200), kind: "decision", rank: "medium" })
  }
  return out
}

interface SessionState {
  bashCount: number
  failures: Map<string, { count: number; errorIds: number[] }>
  seenSentences: Set<string>
}

export interface Promotion {
  signature: string
  errorIds: number[]
}

export class SessionTracker {
  private sessions = new Map<string, SessionState>()

  private state(sessionID: string): SessionState {
    let s = this.sessions.get(sessionID)
    if (!s) {
      s = { bashCount: 0, failures: new Map(), seenSentences: new Set() }
      this.sessions.set(sessionID, s)
    }
    return s
  }

  shouldExtractBash(sessionID: string): boolean {
    const s = this.state(sessionID)
    s.bashCount++
    return s.bashCount % 5 === 0
  }

  isNewSentence(sessionID: string, sentence: string): boolean {
    const s = this.state(sessionID)
    const hash = contentHash(sentence)
    if (s.seenSentences.has(hash)) return false
    s.seenSentences.add(hash)
    return true
  }

  noteError(sessionID: string, signature: string, errorId: number): void {
    const s = this.state(sessionID)
    const entry = s.failures.get(signature) ?? { count: 0, errorIds: [] }
    entry.count++
    entry.errorIds.push(errorId)
    s.failures.set(signature, entry)
  }

  noteSuccess(sessionID: string, signature: string): Promotion | null {
    const s = this.state(sessionID)
    const entry = s.failures.get(signature)
    if (!entry) return null
    s.failures.delete(signature)
    if (entry.count < 2) return null
    return { signature, errorIds: entry.errorIds }
  }

  clear(sessionID: string): void {
    this.sessions.delete(sessionID)
  }
}
