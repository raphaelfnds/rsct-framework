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

interface AddedDiffLine {
  file: string
  line_number: number
  content: string
}

const FILE_HEADER_REGEX = /^\+\+\+\s+(?:b\/)?(.+?)\s*$/
const HUNK_HEADER_REGEX = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/
const KEY_VALUE_REGEX =
  /["']?([a-zA-Z][a-zA-Z0-9_.-]{1,})["']?\s*[:=]\s*["']?([^\s"',;}]+)["']?/g
const EXCERPT_MAX_LENGTH = 160

function* iterateAddedDiffLines(diff: string): Generator<AddedDiffLine> {
  const lines = diff.split('\n')
  let currentFile: string | null = null
  let newLineNumber = 0

  for (const raw of lines) {
    if (raw.startsWith('diff ')) {
      currentFile = null
      continue
    }
    if (raw.startsWith('+++')) {
      if (raw === '+++ /dev/null') {
        currentFile = null
      } else {
        const m = FILE_HEADER_REGEX.exec(raw)
        currentFile = m?.[1] ?? null
      }
      continue
    }
    if (raw.startsWith('---')) continue

    const hunk = HUNK_HEADER_REGEX.exec(raw)
    if (hunk?.[1]) {
      newLineNumber = parseInt(hunk[1], 10)
      continue
    }

    if (raw.startsWith('+')) {
      if (currentFile) {
        yield { file: currentFile, line_number: newLineNumber, content: raw.slice(1) }
      }
      newLineNumber++
      continue
    }
    if (raw.startsWith('-')) continue
    if (raw.startsWith(' ')) {
      newLineNumber++
      continue
    }
  }
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
  const findings: SecretFinding[] = []

  for (const line of iterateAddedDiffLines(diff)) {
    let valueShapeHit = false
    for (const pattern of LINE_VALUE_PATTERNS) {
      const m = pattern.exec(line.content)
      if (m) {
        findings.push({
          file: line.file,
          line_number: line.line_number,
          reason: 'value-shape',
          excerpt: maskExcerpt(line.content, m[0]),
        })
        valueShapeHit = true
        break
      }
    }

    if (!valueShapeHit) {
      KEY_VALUE_REGEX.lastIndex = 0
      let kv: RegExpExecArray | null
      while ((kv = KEY_VALUE_REGEX.exec(line.content)) !== null) {
        const key = kv[1]
        const value = kv[2]
        if (key && value && SECRET_KEY_PATTERN.test(key)) {
          findings.push({
            file: line.file,
            line_number: line.line_number,
            reason: 'key-name',
            excerpt: maskExcerpt(line.content, value),
          })
          break
        }
      }
    }

    for (const { id, pattern } of extraPatterns) {
      pattern.lastIndex = 0
      const m = pattern.exec(line.content)
      if (m && m[0].length > 0) {
        findings.push({
          file: line.file,
          line_number: line.line_number,
          reason: 'extra-pattern',
          pattern_id: id,
          excerpt: maskExcerpt(line.content, m[0]),
        })
        break
      }
    }
  }

  return findings
}
