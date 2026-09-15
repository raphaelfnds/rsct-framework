import { createHash } from 'node:crypto'
import { isAllowlistedBody, isLicenceLine, isLicenceText, LICENCE_MAX_LINES, type AllowlistFamily } from './allowlist.js'
import { scanHtml } from './html-engine.js'
import { classifyPath, type SweepLanguage } from './language.js'
import { lexSqlComments, type SqlDialect } from './sql-lexer.js'
import { scanTree, type TreeLanguage } from './tree-engine.js'

export type ConfiguredSqlDialect = SqlDialect | 'none'

export type UnverifiedReason =
  | 'unsupported_language'
  | 'unknown_extension'
  | 'sql_dialect_missing'
  | 'parse_error'
  | 'binary_or_encoding'
  | 'engine_unavailable'
  | 'git_filter'

export interface SweepComment {
  id: string
  line: number
  text: string
  body: string
}

export type ScanResult =
  | { kind: 'not_code' }
  | { kind: 'unverified'; language: string | null; reason: UnverifiedReason }
  | { kind: 'scanned'; language: SweepLanguage; comments: SweepComment[]; allowlisted: SweepComment[] }

export interface ScanOptions {
  sqlDialect?: ConfiguredSqlDialect | undefined
  grammarsDir?: string | null | undefined
}

interface Span {
  start: number
  end: number
  family: AllowlistFamily
}

type Collected = { ok: true; spans: Span[] } | { ok: false; reason: UnverifiedReason; language: string | null }

const UTF8 = new TextDecoder('utf-8', { fatal: true })

function firstLineOf(bytes: Uint8Array): string {
  const limit = Math.min(bytes.length, 256)
  let end = 0
  while (end < limit && bytes[end] !== 0x0a) end++
  return Buffer.from(bytes.subarray(0, end)).toString('latin1')
}

function decode(bytes: Uint8Array): string | null {
  if (bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))) {
    return null
  }
  if (bytes.includes(0)) return null
  try {
    const text = UTF8.decode(bytes)
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  } catch {
    return null
  }
}

export function commentBody(text: string): string {
  let body = text
  if (body.startsWith('<!--')) {
    body = body.slice(4)
    if (body.endsWith('-->')) body = body.slice(0, -3)
  } else if (body.startsWith('/*')) {
    body = body.replace(/^\/\*+/, '').replace(/\*+\/$/, '')
  } else if (body.startsWith('//')) {
    body = body.replace(/^\/\/+/, '')
  } else if (body.startsWith('--')) {
    body = body.slice(2)
  } else if (body.startsWith('#')) {
    body = body.replace(/^#+/, '')
  }
  return collapseWhitespace(body)
}

export function collapseWhitespace(text: string): string {
  return text.replace(/\r/g, '').replace(/\s+/g, ' ').trim()
}

function treeFamily(language: TreeLanguage): AllowlistFamily {
  switch (language) {
    case 'python':
      return 'python'
    case 'php':
      return 'php'
    case 'java':
      return 'java'
    case 'css':
      return 'css'
    default:
      return 'script'
  }
}

async function collectHtml(
  source: string,
  base: number,
  asFragment: boolean,
  grammarsDir: string | null | undefined,
): Promise<Collected> {
  const scan = scanHtml(source, asFragment)
  const spans: Span[] = []
  for (const c of scan.comments) {
    const text = source.slice(c.start, c.end)
    if (text.startsWith('<![CDATA[')) return { ok: false, reason: 'parse_error', language: 'html' }
    if (/^<\?xml[\s?]/i.test(text)) continue
    spans.push({ start: base + c.start, end: base + c.end, family: 'html' })
  }
  for (const inline of scan.inline) {
    const text = source.slice(inline.start, inline.end)
    if (inline.kind === 'script_data' || text.trim().length === 0) continue
    if (inline.kind === 'script_other') {
      return { ok: false, reason: 'unsupported_language', language: 'html-script' }
    }
    const language: TreeLanguage = inline.kind === 'style' ? 'css' : 'javascript'
    const tree = await scanTree(language, text, grammarsDir)
    if (!tree.ok) return { ok: false, reason: tree.reason, language }
    for (const c of tree.comments) {
      spans.push({ start: base + inline.start + c.start, end: base + inline.start + c.end, family: treeFamily(language) })
    }
  }
  return { ok: true, spans }
}

async function collect(
  language: SweepLanguage,
  source: string,
  options: ScanOptions,
): Promise<Collected> {
  if (language === 'sql') {
    const dialect = options.sqlDialect
    if (dialect !== 'postgresql' && dialect !== 'mysql') {
      return { ok: false, reason: 'sql_dialect_missing', language }
    }
    const lexed = lexSqlComments(source, dialect)
    if (!lexed.ok) return { ok: false, reason: 'parse_error', language }
    const family: AllowlistFamily = dialect === 'mysql' ? 'sql_mysql' : 'sql_postgresql'
    return { ok: true, spans: lexed.comments.map((c) => ({ ...c, family })) }
  }
  if (language === 'html') return collectHtml(source, 0, false, options.grammarsDir)
  const tree = await scanTree(language, source, options.grammarsDir)
  if (!tree.ok) return { ok: false, reason: tree.reason, language }
  const spans: Span[] = tree.comments.map((c) => ({ ...c, family: treeFamily(language) }))
  for (const t of tree.texts) {
    const nested = await collectHtml(source.slice(t.start, t.end), t.start, true, options.grammarsDir)
    if (!nested.ok) return nested
    spans.push(...nested.spans)
  }
  return { ok: true, spans }
}

function lineStarts(source: string): number[] {
  const starts = [0]
  for (let i = 0; i < source.length; i++) if (source.charCodeAt(i) === 10) starts.push(i + 1)
  return starts
}

function lineAt(starts: number[], offset: number): number {
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid]! <= offset) lo = mid
    else hi = mid - 1
  }
  return lo + 1
}

function licenceGroup(source: string, spans: Span[], starts: number[]): Set<number> {
  const allowed = new Set<number>()
  let k = 0
  let prevEnd = 0
  if (spans[0] && spans[0].start === 0 && source.startsWith('#!')) {
    k = 1
    prevEnd = spans[0].end
  }
  const first = spans[k]
  if (!first) return allowed
  const gap = source.slice(prevEnd, first.start).replace(/^#![^\n]*\n/, '').replace(/^\s*<\?php\b/, '')
  if (gap.trim().length > 0) return allowed
  const members = [k]
  const firstText = source.slice(first.start, first.end)
  if (!firstText.startsWith('/*') && !firstText.startsWith('<!--')) {
    for (let j = k + 1; j < spans.length; j++) {
      const between = source.slice(spans[j - 1]!.end, spans[j]!.start)
      const text = source.slice(spans[j]!.start, spans[j]!.end)
      if (!/^[ \t]*\r?\n[ \t]*$/.test(between) || text.startsWith('/*')) break
      members.push(j)
    }
  }
  const last = spans[members[members.length - 1]!]!
  const lines = lineAt(starts, last.end) - lineAt(starts, first.start) + 1
  const groupText = source.slice(first.start, last.end)
  if (lines > LICENCE_MAX_LINES || !isLicenceText(groupText)) return allowed
  if (members.length === 1 && (firstText.startsWith('/*') || firstText.startsWith('<!--'))) {
    allowed.add(k)
    return allowed
  }
  for (const m of members) {
    const span = spans[m]!
    if (isLicenceLine(commentBody(source.slice(span.start, span.end)))) allowed.add(m)
  }
  return allowed
}

export async function scanFile(path: string, bytes: Uint8Array, options: ScanOptions = {}): Promise<ScanResult> {
  const bucket = classifyPath(path, firstLineOf(bytes))
  if (bucket.bucket === 'not_code') return { kind: 'not_code' }
  if (bucket.bucket === 'unknown') return { kind: 'unverified', language: null, reason: 'unknown_extension' }
  if (bucket.bucket === 'unsupported') {
    return { kind: 'unverified', language: bucket.language, reason: 'unsupported_language' }
  }
  const language = bucket.language
  const source = decode(bytes)
  if (source === null) return { kind: 'unverified', language, reason: 'binary_or_encoding' }
  const collected = await collect(language, source, options)
  if (!collected.ok) return { kind: 'unverified', language: collected.language, reason: collected.reason }

  const spans = [...collected.spans].sort((a, b) => a.start - b.start)
  const starts = lineStarts(source)
  const licence = licenceGroup(source, spans, starts)
  const ordinals = new Map<string, number>()
  const comments: SweepComment[] = []
  const allowlisted: SweepComment[] = []
  spans.forEach((span, index) => {
    const text = source.slice(span.start, span.end)
    const body = commentBody(text)
    const ordinal = ordinals.get(body) ?? 0
    ordinals.set(body, ordinal + 1)
    const id = createHash('sha256').update(`${path}\0${body}\0${ordinal}`).digest('hex').slice(0, 16)
    const comment: SweepComment = { id, line: lineAt(starts, span.start), text, body }
    const shebang = span.start === 0 && text.startsWith('#!')
    if (shebang || licence.has(index) || isAllowlistedBody(span.family, body)) allowlisted.push(comment)
    else comments.push(comment)
  })
  return { kind: 'scanned', language, comments, allowlisted }
}
