import { createHash } from "node:crypto"

export const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "if", "then", "else", "for", "of", "to", "in", "on",
  "at", "by", "with", "from", "as", "is", "are", "was", "were", "be", "been", "it", "its",
  "this", "that", "these", "those", "we", "you", "they", "he", "she", "not", "no", "yes",
  "do", "does", "did", "can", "will", "would", "should", "must", "may", "might", "shall",
  "have", "has", "had", "use", "used", "using", "when", "what", "which", "who", "how",
  "all", "any", "some", "more", "most", "other", "into", "than", "so", "only", "also",
  "и", "в", "во", "не", "на", "что", "с", "со", "для", "это", "этом", "как", "но", "или",
  "же", "бы", "из", "по", "у", "за", "то", "при", "о", "от", "до", "если", "когда",
  "есть", "нет", "да", "только", "ещё", "уже", "все", "всё", "для",
])

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}

export function normalizeContent(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase()
}

export function contentHash(text: string): string {
  return sha256(normalizeContent(text))
}

export function tokenize(text: string): string[] {
  return normalizeContent(text).split(/[^\p{L}\p{N}_]+/u).filter((t) => t.length > 0)
}

export function tokenSet(text: string): Set<string> {
  return new Set(tokenize(text))
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter++
  const union = a.size + b.size - inter
  return union === 0 ? 0 : inter / union
}

export function keywordsFrom(text: string, extra: string[] = [], max = 6): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const source of [extra, tokenize(text)]) {
    for (const t of source) {
      const k = t.toLowerCase()
      if (k.length < 4 || STOPWORDS.has(k) || seen.has(k)) continue
      seen.add(k)
      out.push(k)
      if (out.length >= max) return out
    }
  }
  return out
}

export function ftsQuery(text: string): string {
  const tokens = tokenize(text).filter((t) => t.length >= 2).slice(0, 8)
  if (tokens.length === 0) return ""
  return tokens.map((t) => `"${t}"`).join(" OR ")
}

export function stripMarkdown(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/^#+\s*/, "")
    .trim()
}

export function nowISO(): string {
  return new Date().toISOString()
}

export function todayISO(): string {
  return new Date().toISOString().slice(0, 10)
}

export function daysSince(iso: string): number {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return 0
  return Math.max(0, (Date.now() - t) / 86_400_000)
}

export function parseVerifiedDate(text: string): string | null {
  const m = text.match(/(?:проверено|verified)[^0-9]{0,3}(\d{4}-\d{2}-\d{2})/i)
  return m ? m[1] : null
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1).trimEnd() + "…"
}

export function titleFrom(content: string, keywords: string[] = []): string {
  if (keywords.length > 0) {
    return keywords.slice(0, 2).map((k) => k[0].toUpperCase() + k.slice(1)).join(" ")
  }
  const words = content.split(/\s+/).slice(0, 5).join(" ")
  return truncate(words, 60)
}
