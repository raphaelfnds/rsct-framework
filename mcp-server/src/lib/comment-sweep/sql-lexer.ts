export type SqlDialect = 'postgresql' | 'mysql'

export interface SqlCommentSpan {
  start: number
  end: number
}

export type SqlLexResult = { ok: true; comments: SqlCommentSpan[] } | { ok: false }

const IDENT_CHAR = /[A-Za-z0-9_$-￿]/
const DOLLAR_TAG = /^\$([A-Za-z_-￿][A-Za-z0-9_-￿]*)?\$/
const PROCEDURAL_SQL = new Set(['sql', 'plpgsql'])

class LexError extends Error {}

function isIdentChar(ch: string | undefined): boolean {
  return ch !== undefined && IDENT_CHAR.test(ch)
}

function skipQuoted(src: string, i: number, quote: string, backslash: boolean): number {
  let j = i + 1
  while (j < src.length) {
    const ch = src[j]
    if (backslash && ch === '\\') {
      j += 2
      continue
    }
    if (ch === quote) {
      if (src[j + 1] === quote) {
        j += 2
        continue
      }
      return j + 1
    }
    j++
  }
  throw new LexError()
}

function skipBlock(src: string, i: number, nested: boolean): number {
  let depth = 1
  let j = i + 2
  while (j < src.length) {
    if (nested && src[j] === '/' && src[j + 1] === '*') {
      depth++
      j += 2
      continue
    }
    if (src[j] === '*' && src[j + 1] === '/') {
      depth--
      j += 2
      if (depth === 0) return j
      continue
    }
    j++
  }
  throw new LexError()
}

function lineEnd(src: string, i: number): number {
  const nl = src.indexOf('\n', i)
  const end = nl === -1 ? src.length : nl
  return end > i && src[end - 1] === '\r' ? end - 1 : end
}

interface Body {
  innerStart: number
  innerEnd: number
}

function lex(src: string, offset: number, dialect: SqlDialect, out: SqlCommentSpan[]): void {
  const mysql = dialect === 'mysql'
  let i = 0
  let statement = ''
  let bodies: Body[] = []

  const finishStatement = (): void => {
    if (bodies.length === 0) {
      statement = ''
      return
    }
    const langMatch = /\bLANGUAGE\s+'?([A-Za-z0-9_]+)'?/i.exec(statement)
    const lexable = langMatch
      ? PROCEDURAL_SQL.has(langMatch[1]!.toLowerCase())
      : /^\s*DO\b/i.test(statement)
    for (const body of bodies) {
      const inner = src.slice(body.innerStart, body.innerEnd)
      if (lexable) {
        lex(inner, offset + body.innerStart, dialect, out)
      } else if (inner.includes('--') || inner.includes('/*')) {
        throw new LexError()
      }
    }
    statement = ''
    bodies = []
  }

  while (i < src.length) {
    const ch = src[i]!
    const next = src[i + 1]

    if (ch === '-' && next === '-') {
      const after = src[i + 2]
      if (!mysql || after === undefined || /[\s\x00-\x1f]/.test(after)) {
        const end = lineEnd(src, i)
        out.push({ start: offset + i, end: offset + end })
        statement += ' '
        i = end
        continue
      }
    }

    if (mysql && ch === '#') {
      const end = lineEnd(src, i)
      out.push({ start: offset + i, end: offset + end })
      statement += ' '
      i = end
      continue
    }

    if (ch === '/' && next === '*') {
      if (mysql && src[i + 2] === '!') {
        const end = skipBlock(src, i, false)
        statement += src.slice(i, end)
        i = end
        continue
      }
      const end = skipBlock(src, i, !mysql)
      out.push({ start: offset + i, end: offset + end })
      statement += ' '
      i = end
      continue
    }

    if (ch === "'") {
      const prev = src[i - 1]
      const escaped =
        mysql || ((prev === 'E' || prev === 'e') && !isIdentChar(src[i - 2]))
      const end = skipQuoted(src, i, "'", escaped)
      statement += src.slice(i, end)
      i = end
      continue
    }

    if (ch === '"') {
      const end = skipQuoted(src, i, '"', mysql)
      statement += src.slice(i, end)
      i = end
      continue
    }

    if (mysql && ch === '`') {
      const end = skipQuoted(src, i, '`', false)
      statement += src.slice(i, end)
      i = end
      continue
    }

    if (!mysql && ch === '$' && !isIdentChar(src[i - 1])) {
      const tag = DOLLAR_TAG.exec(src.slice(i))
      if (tag) {
        const open = tag[0]
        const close = src.indexOf(open, i + open.length)
        if (close === -1) throw new LexError()
        bodies.push({ innerStart: i + open.length, innerEnd: close })
        statement += ' '
        i = close + open.length
        continue
      }
    }

    if (ch === ';') {
      finishStatement()
      i++
      continue
    }

    statement += ch
    i++
  }
  finishStatement()
}

export function lexSqlComments(src: string, dialect: SqlDialect): SqlLexResult {
  const comments: SqlCommentSpan[] = []
  try {
    lex(src, 0, dialect, comments)
  } catch (err) {
    if (err instanceof LexError) return { ok: false }
    throw err
  }
  comments.sort((a, b) => a.start - b.start)
  return { ok: true, comments }
}
