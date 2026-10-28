/**
 * Single source of truth for INV-6 secret detection.
 *
 * Patterns were originally drafted in an early Bash-hook prototype
 * (sectionE-secrets-leak.sh) that was superseded when the framework
 * adopted the MCP-first architecture; this file is the canonical
 * home now. Any change to the secret regex MUST land here so it
 * propagates to all consumers (rsct_get_environments masking today,
 * rsct_check_secrets in F2.5).
 */

export const MASK_PLACEHOLDER = '***MASKED***'

/**
 * Case-insensitive substring match against the key name. If the key
 * contains any of these tokens, the value is treated as a secret.
 */
export const SECRET_KEY_PATTERN =
  /\b(jwt[._-]?secret|api[._-]?key|secret|token|password|bearer|credential)\b/i

/**
 * Value shapes that strongly indicate a credential regardless of key name.
 */
export const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /^sk-[a-zA-Z0-9]{20,}$/, // OpenAI / Anthropic-style
  /^AKIA[0-9A-Z]{16}$/, // AWS access key
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, // PEM private key block
] as const

export type MaskReason = 'key-name' | 'value-shape'

export interface MaskResult {
  masked: boolean
  value: string
  reason?: MaskReason
}

/**
 * Mask a key/value pair if either the key name or the value shape
 * matches an INV-6 pattern. Empty values are never masked (placeholder).
 */
export function maskIfSecret(key: string, value: string): MaskResult {
  if (value.length === 0) return { masked: false, value }

  if (SECRET_KEY_PATTERN.test(key)) {
    return { masked: true, value: MASK_PLACEHOLDER, reason: 'key-name' }
  }

  for (const pattern of SECRET_VALUE_PATTERNS) {
    if (pattern.test(value)) {
      return { masked: true, value: MASK_PLACEHOLDER, reason: 'value-shape' }
    }
  }

  return { masked: false, value }
}

/**
 * Line-scan variants of the value-shape patterns. `SECRET_VALUE_PATTERNS`
 * is anchored (`^...$`) because M1's `maskIfSecret` receives an already-
 * extracted env value. When scanning a raw diff line, we need a pattern
 * that finds the credential anywhere in the line, with token boundaries
 * to avoid matches inside larger random strings.
 */
const LINE_VALUE_PATTERNS: readonly RegExp[] = [
  /\bsk-[a-zA-Z0-9]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
] as const

export type SecretFindingReason = MaskReason | 'extra-pattern'

export interface SecretFinding {
  file: string
  line_number: number | null
  reason: SecretFindingReason
  pattern_id?: string
  excerpt: string
}

export interface ExtraPattern {
  id: string
  pattern: RegExp
}

export interface CompileExtraResult {
  compiled: ExtraPattern[]
  invalid: Array<{ index: number; pattern: string; error: string }>
}

/**
 * Canonical compiler for the user-supplied regex strings in
 * `.rsct.json` `secrets_extra_patterns[]`. Returns the compiled patterns
 * alongside any entries whose `new RegExp(str)` threw — the caller may
 * surface those (rsct_check_secrets does) or ignore them
 * (rsct_request_commit does) but the compile loop itself is owned here
 * so the two call sites cannot drift.
 */
export function compileExtraPatterns(
  patternStrings: ReadonlyArray<string>,
): CompileExtraResult {
  const compiled: ExtraPattern[] = []
  const invalid: Array<{ index: number; pattern: string; error: string }> = []
  patternStrings.forEach((str, index) => {
    try {
      compiled.push({ id: `extra-${index}`, pattern: new RegExp(str) })
    } catch (err) {
      invalid.push({
        index,
        pattern: str,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  })
  return { compiled, invalid }
}

const FILE_HEADER_REGEX = /^\+\+\+\s+(.+?)\s*$/
const HUNK_HEADER_REGEX = /^@@\s+-\d+(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/
export const KEY_VALUE_REGEX =
  /["']?(?=[a-zA-Z])(?<![a-zA-Z][a-zA-Z0-9_.-]*?)([a-zA-Z](?=([a-zA-Z0-9_.-]+))\2)["']?\s*[:=]\s*["']?([^\s"',;}]+)["']?/g
const EXCERPT_MAX_LENGTH = 160

const C_ESCAPES: Readonly<Record<string, string>> = { a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '"': '"', '\\': '\\' }

export function unquoteGitPath(path: string): string {
  if (path.length < 2 || !path.startsWith('"') || !path.endsWith('"')) return path
  const chars = Array.from(path.slice(1, -1))
  const bytes: number[] = []
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!
    if (ch !== '\\' || i === chars.length - 1) {
      bytes.push(...Buffer.from(ch, 'utf8'))
      continue
    }
    const octal = chars.slice(i + 1, i + 4).join('')
    if (/^[0-7]{3}$/.test(octal)) {
      bytes.push(parseInt(octal, 8))
      i += 3
      continue
    }
    const next = chars[i + 1]!
    bytes.push(...Buffer.from(C_ESCAPES[next] ?? `\\${next}`, 'utf8'))
    i += 1
  }
  return Buffer.from(bytes).toString('utf8')
}

function headerPath(raw: string): string | null {
  const m = FILE_HEADER_REGEX.exec(raw)
  if (!m?.[1] || m[1] === '/dev/null') return null
  const path = unquoteGitPath(m[1])
  return path.startsWith('b/') ? path.slice(2) : path
}

export function normalizeDiffLine(raw: string): string {
  const withoutNul = raw.includes('\0') ? raw.replace(/\0/g, '') : raw
  return withoutNul.endsWith('\r') ? withoutNul.slice(0, -1) : withoutNul
}

export interface DiffScanner {
  line(raw: string): void
  readonly findings: SecretFinding[]
}

function maskExcerpt(line: string, matched: string): string {
  const masked = matched.length > 0 ? line.split(matched).join(MASK_PLACEHOLDER) : line
  return masked.length > EXCERPT_MAX_LENGTH
    ? `${masked.slice(0, EXCERPT_MAX_LENGTH - 3)}...`
    : masked
}

/**
 * Scan a unified-diff string for secrets in added lines.
 *
 * Detection order per line:
 *   1. `value-shape` — line matches any pattern in {@link SECRET_VALUE_PATTERNS}
 *      (sk-, AKIA, PEM BEGIN, ...).
 *   2. `key-name`    — line contains a key/value pair where the key matches
 *      {@link SECRET_KEY_PATTERN} and the value is non-empty.
 *   3. `extra-pattern` — line matches any caller-provided regex; the finding
 *      carries `pattern_id` so the dev can trace back to which entry of
 *      `.rsct.json` `secrets_extra_patterns[]` fired.
 *
 * At most one finding per category per line (so a line with two
 * `secrets_extra_patterns` hits still yields a single extra-pattern
 * finding for the first match — keeps output noise low for v1).
 *
 * Excerpts are masked: the matched substring is replaced by
 * `***MASKED***` before being returned so audit consumers cannot
 * accidentally re-leak the value they just blocked.
 */
export function scanDiffForSecrets(
  diff: string,
  extraPatterns: ReadonlyArray<ExtraPattern> = [],
): SecretFinding[] {
  const scanner = createDiffScanner(extraPatterns)
  for (const raw of diff.split('\n')) scanner.line(raw)
  return scanner.findings
}

export function createDiffScanner(extraPatterns: ReadonlyArray<ExtraPattern> = []): DiffScanner {
  const findings: SecretFinding[] = []
  let currentFile: string | null = null
  let inHunk = false
  let oldLeft = 0
  let newLeft = 0
  let newLineNumber = 0

  const scanAddedLine = (file: string, lineNumber: number, content: string): void => {
    let valueShapeHit = false
    for (const pattern of LINE_VALUE_PATTERNS) {
      const m = pattern.exec(content)
      if (m) {
        findings.push({ file, line_number: lineNumber, reason: 'value-shape', excerpt: maskExcerpt(content, m[0]) })
        valueShapeHit = true
        break
      }
    }

    if (!valueShapeHit) {
      KEY_VALUE_REGEX.lastIndex = 0
      let kv: RegExpExecArray | null
      while ((kv = KEY_VALUE_REGEX.exec(content)) !== null) {
        const key = kv[1]
        const value = kv[3]
        if (key && value && SECRET_KEY_PATTERN.test(key)) {
          findings.push({ file, line_number: lineNumber, reason: 'key-name', excerpt: maskExcerpt(content, value) })
          break
        }
      }
    }

    for (const { id, pattern } of extraPatterns) {
      pattern.lastIndex = 0
      const m = pattern.exec(content)
      if (m && m[0].length > 0) {
        findings.push({
          file,
          line_number: lineNumber,
          reason: 'extra-pattern',
          pattern_id: id,
          excerpt: maskExcerpt(content, m[0]),
        })
        break
      }
    }
  }

  const line = (input: string): void => {
    const raw = normalizeDiffLine(input)
    if (inHunk) {
      if (raw.startsWith('+')) {
        if (currentFile) scanAddedLine(currentFile, newLineNumber, raw.slice(1))
        newLineNumber++
        newLeft--
      } else if (raw.startsWith('-')) {
        oldLeft--
      } else if (raw.startsWith(' ')) {
        newLineNumber++
        oldLeft--
        newLeft--
      } else if (!raw.startsWith('\\')) {
        inHunk = false
      }
      if (inHunk) {
        if (oldLeft <= 0 && newLeft <= 0) inHunk = false
        return
      }
    }
    if (raw.startsWith('diff ')) {
      currentFile = null
      return
    }
    const hunk = HUNK_HEADER_REGEX.exec(raw)
    if (hunk?.[2]) {
      oldLeft = hunk[1] === undefined ? 1 : parseInt(hunk[1], 10)
      newLineNumber = parseInt(hunk[2], 10)
      newLeft = hunk[3] === undefined ? 1 : parseInt(hunk[3], 10)
      inHunk = oldLeft > 0 || newLeft > 0
      return
    }
    if (raw.startsWith('+++')) currentFile = headerPath(raw)
  }

  return { line, findings }
}
