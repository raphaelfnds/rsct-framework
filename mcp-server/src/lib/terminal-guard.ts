import { spawnSync } from 'node:child_process'

export type ShellDialect = 'bash' | 'powershell'

export type TerminalVerdict = { verdict: 'allow' } | { verdict: 'deny'; reason: string }

export type AliasLookup = { found: true; value: string } | { found: false } | { error: string }

export type AliasResolver = (name: string, gitDir: string | null, cwd: string | undefined, timeoutMs: number) => AliasLookup

export interface JudgeOptions {
  dialect?: ShellDialect
  cwd?: string
  resolveAlias?: AliasResolver
  aliasBudgetMs?: number
  now?: () => number
}

const BLOCKED_GIT_VERBS: ReadonlyMap<string, string> = new Map([
  ['commit', 'rsct_request_commit'],
  ['push', 'rsct_request_push'],
  ['merge', 'rsct_request_merge'],
  ['rebase', 'rsct_request_rebase'],
  ['cherry-pick', 'rsct_request_commit'],
  ['revert', 'rsct_request_commit'],
  ['am', 'rsct_request_commit'],
])

const RECOVERY_VERBS = new Set(['merge', 'rebase', 'cherry-pick', 'revert', 'am'])
const RECOVERY_FLAGS = new Set(['--abort', '--quit', '--continue', '--skip'])

const GIT_VALUE_OPTIONS = new Set(['-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix', '--list-cmds', '--attr-source'])
const GIT_GLOBAL_FLAGS = new Set([
  '-p', '-P', '--paginate', '--no-pager', '--bare', '--no-replace-objects', '--no-lazy-fetch', '--no-optional-locks',
  '--no-advice', '--literal-pathspecs', '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs', '--exec-path',
  '--html-path', '--man-path', '--info-path', '-v', '--version', '-h', '--help',
])
const START_PROCESS = new Set(['start-process', 'saps', 'start'])
const START_PROCESS_PARAMS: ReadonlyMap<string, 'program' | 'arguments' | 'value' | 'switch'> = new Map([
  ['filepath', 'program'], ['pspath', 'program'], ['path', 'program'],
  ['argumentlist', 'arguments'], ['args', 'arguments'],
  ['workingdirectory', 'value'], ['windowstyle', 'value'], ['verb', 'value'], ['credential', 'value'], ['environment', 'value'],
  ['redirectstandardinput', 'value'], ['redirectstandardoutput', 'value'], ['redirectstandarderror', 'value'],
  ['erroraction', 'value'], ['warningaction', 'value'], ['informationaction', 'value'], ['progressaction', 'value'],
  ['errorvariable', 'value'], ['warningvariable', 'value'], ['informationvariable', 'value'], ['outvariable', 'value'],
  ['outbuffer', 'value'], ['pipelinevariable', 'value'],
  ['loaduserprofile', 'switch'], ['lup', 'switch'], ['nonewwindow', 'switch'], ['nnw', 'switch'], ['passthru', 'switch'],
  ['wait', 'switch'], ['usenewenvironment', 'switch'], ['verbose', 'switch'], ['debug', 'switch'], ['whatif', 'switch'],
  ['confirm', 'switch'],
])
const WRAPPERS = new Set(['sudo', 'doas', 'env', 'command', 'exec', 'nohup', 'time', 'nice', 'xargs', 'builtin'])
const SHELL_KEYWORDS = new Set(['if', 'then', 'elif', 'else', 'do', 'while', 'until', '!'])
const POWERSHELL_VALUE_OPTIONS = [
  'executionpolicy', 'windowstyle', 'inputformat', 'outputformat', 'version', 'psconsolefile',
  'configurationname', 'workingdirectory', 'custompipename', 'settingsfile',
]
const POWERSHELL_VALUE_ALIASES = new Set(['ep', 'ex', 'w', 'wd', 'v'])
const INTERPRETER_VALUE_OPTIONS = new Set(['-X', '-W', '-r', '--require', '--import', '--loader', '--experimental-loader', '--input-type', '-C', '--conditions', '--title', '--disable-warning'])
const GH_VALUE_OPTIONS = new Set(['-R', '--repo', '--hostname'])

const GIT_BUILTINS = new Set(
  (
    'add am annotate apply archive backfill bisect blame branch bugreport bundle cat-file check-attr check-ignore ' +
    'check-mailmap check-ref-format checkout checkout-index cherry cherry-pick citool clean clone column commit ' +
    'commit-graph commit-tree config count-objects credential credential-cache credential-store describe diagnose ' +
    'diff diff-files diff-index diff-pairs diff-tree difftool fast-export fast-import fetch fetch-pack filter-branch ' +
    'fmt-merge-msg for-each-ref for-each-repo format-patch fsck fsck-objects gc get-tar-commit-id grep gui ' +
    'hash-object help hook http-backend http-fetch http-push imap-send index-pack init init-db instaweb ' +
    'interpret-trailers last-modified log ls-files ls-remote ls-tree mailinfo mailsplit maintenance merge merge-base ' +
    'merge-file merge-index merge-one-file merge-tree mergetool mktag mktree multi-pack-index mv name-rev notes ' +
    'pack-objects pack-redundant pack-refs patch-id prune prune-packed pull push quiltimport range-diff read-tree ' +
    'rebase receive-pack reflog refs remote repack replace replay repo request-pull rerere reset restore rev-list ' +
    'rev-parse revert rm scalar send-email send-pack sh-i18n sh-setup shortlog show show-branch show-index show-ref ' +
    'sparse-checkout stage stash status stripspace submodule switch symbolic-ref tag unpack-file unpack-objects ' +
    'update-index update-ref update-server-info upload-archive upload-pack var verify-commit verify-pack verify-tag ' +
    'version whatchanged worktree write-tree'
  ).split(' '),
)

const POSIX_SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash', 'fish', 'csh', 'tcsh', 'yash', 'posh'])
const POWERSHELLS = new Set(['powershell', 'pwsh', 'powershell_ise'])
const DISTRO_LAUNCHERS = /^(ubuntu[\d.]*|debian|kali|kali-linux|opensuse[\w.-]*|sles[\w.-]*|fedora[\w.-]*|alpine|oraclelinux[\w.-]*|almalinux[\w.-]*)$/
const WSL_VALUE_OPTIONS = new Set(['-d', '--distribution', '-u', '--user', '--cd', '--shell-type', '--distribution-id'])
const SSH_VALUE_OPTIONS = new Set(['-b', '-c', '-D', '-E', '-e', '-F', '-I', '-i', '-J', '-L', '-l', '-m', '-O', '-o', '-p', '-Q', '-R', '-S', '-W', '-w', '-B'])
type CodeFlag = { separate: RegExp; attached: RegExp; switches?: RegExp }
const NODE_CODE_FLAG: CodeFlag = { separate: /^(-e|--eval|-p|--print|-pe|-ep)$/, attached: /^--(?:eval|print)=(.*)$/s }
const PYTHON_CODE_FLAG: CodeFlag = {
  separate: /^-[bBdEhiIOPqsSuvVxR]*c$/,
  attached: /^-[bBdEhiIOPqsSuvVxR]*c(.+)$/s,
  switches: /^-[bBdEhiIOPqsSuvVxR]+$/,
}
const INTERPRETER_FLAGS: ReadonlyMap<string, CodeFlag> = new Map([
  ['node', NODE_CODE_FLAG],
  ['nodejs', NODE_CODE_FLAG],
  ['bun', NODE_CODE_FLAG],
  ['tsx', NODE_CODE_FLAG],
  ['ts-node', NODE_CODE_FLAG],
  ['python', PYTHON_CODE_FLAG],
  ['python3', PYTHON_CODE_FLAG],
  ['python2', PYTHON_CODE_FLAG],
  ['py', PYTHON_CODE_FLAG],
  ['pythonw', PYTHON_CODE_FLAG],
  ['perl', { separate: /^-[acnpstTuUvwWXl0-9fg]*[eE]$/, attached: /^-[acnpstTuUvwWXl0-9fg]*[eE](.+)$/s, switches: /^-[acnpstTuUvwWXl0-9fg]+$/ }],
  ['ruby', { separate: /^-[acdlnpsSvwyU0-9]*e$/, attached: /^-[acdlnpsSvwyU0-9]*e(.+)$/s, switches: /^-[acdlnpsSvwyU0-9]+$/ }],
  ['php', { separate: /^-r$/, attached: /^-r(.+)$/s, switches: /^-[aChHiqsvw]+$/ }],
])
const SU_COMMAND_FLAG: CodeFlag = {
  separate: /^(-[a-zA-Z]*c|--command|--session-command)$/,
  attached: /^(?:-[a-zA-Z]*?c|--command=|--session-command=)(.+)$/s,
}
const ENV_SPLIT_FLAG: CodeFlag = { separate: /^(-[a-zA-Z0]*S|--split-string)$/, attached: /^(?:-[a-zA-Z0]*?S|--split-string=)(.+)$/s }
const STDIN_SCRIPTS = new Set(['-', '/dev/stdin', '/dev/fd/0', '/proc/self/fd/0'])

const VERBS_PATTERN = 'commit|push|merge|rebase|cherry-pick|revert|am'
const VALUE_OPTIONS_PATTERN = ['-C', ...GIT_VALUE_OPTIONS].join('|')
const CODE_GIT_TEXT = new RegExp(
  `\\bgit(?:\\.exe)?\\s+(?:(?:${VALUE_OPTIONS_PATTERN})\\s+(?:"[^"]*"|'[^']*'|\\S+)\\s+|-{1,2}[\\w.=:/-]+\\s+)*(${VERBS_PATTERN})(?![\\w-])`,
  'i',
)
const CODE_GIT_ARGV = new RegExp(
  `["'\`]git(?:\\.exe)?["'\`]\\s*,\\s*(?:\\{[^}]*?\\bargs\\s*:\\s*)?(?:\\[\\s*)?` +
    `(?:["'\`](?:${VALUE_OPTIONS_PATTERN})["'\`]\\s*,\\s*(?:["'\`][^"'\`]*["'\`]|[\\w.$]+)\\s*,\\s*|["'\`]-[^"'\`]*["'\`]\\s*,\\s*)*` +
    `["'\`](${VERBS_PATTERN})["'\`]`,
  'i',
)
const CODE_GH_MERGE = /\bgh(?:\.exe)?\s+(?:-\S+\s+(?:\S+\s+)?)*pr\s+merge\b/i
const CODE_GH_ARGV = new RegExp(
  `["'\`]gh(?:\\.exe)?["'\`]\\s*,\\s*(?:\\[\\s*)?(?:["'\`][^"'\`]*["'\`]\\s*,\\s*)*?["'\`]pr["'\`]\\s*,\\s*(?:["'\`]-[^"'\`]*["'\`]\\s*,\\s*)*["'\`]merge["'\`]`,
  'i',
)
const HOOKS_OFF_KEY = /disableallhooks/i

const MAX_DEPTH = 8
const MAX_ALIAS_DEPTH = 5
const DEFAULT_ALIAS_BUDGET_MS = 3000

type Token =
  | { kind: 'word'; value: string; expansion: boolean; quoted?: true; listed?: true; redirect?: true }
  | { kind: 'sep' }
  | { kind: 'body'; text: string; via: 'heredoc' | 'herestring' }

interface Lexed {
  tokens: Token[]
  nested: Array<{ text: string; dialect: ShellDialect }>
}

interface Ctx {
  depth: number
  aliasDepth: number
  cwd: string | undefined
  resolveAlias: AliasResolver
  deadline: number
  now: () => number
}

const ALLOW: TerminalVerdict = { verdict: 'allow' }

function deny(reason: string): TerminalVerdict {
  return { verdict: 'deny', reason }
}

function isDeny(v: TerminalVerdict): v is { verdict: 'deny'; reason: string } {
  return v.verdict === 'deny'
}

export function decodeUnicodeEscapes(text: string): string {
  return text.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
}

export function programName(word: string): string {
  const last = word.split(/[\\/]/).pop() ?? word
  return last.toLowerCase().replace(/\.(exe|cmd|bat|com)$/, '')
}

type Heredoc = { delim: string; strip: boolean; quoted: boolean }

function readHeredocStart(text: string, from: number): { heredoc: Heredoc | null; end: number } {
  let j = from
  const strip = text[j] === '-'
  if (strip) j++
  while (text[j] === ' ' || text[j] === '\t') j++
  const m = /^(?:'([^']*)'|"([^"]*)"|\\?([^\s;&|<>()]+))/.exec(text.slice(j))
  if (!m) return { heredoc: null, end: j }
  return { heredoc: { delim: (m[1] ?? m[2] ?? m[3] ?? '').replace(/["'\\]/g, ''), strip, quoted: /['"\\]/.test(m[0]) }, end: j + m[0].length }
}

function readHeredocBody(text: string, from: number, h: Heredoc): { body: string; end: number } {
  const lines: string[] = []
  let i = from
  while (i < text.length) {
    const nl = text.indexOf('\n', i)
    const raw = nl === -1 ? text.slice(i) : text.slice(i, nl)
    i = nl === -1 ? text.length : nl + 1
    const line = raw.replace(/\r$/, '')
    if ((h.strip ? line.replace(/^\t+/, '') : line) === h.delim) break
    lines.push(line)
  }
  return { body: lines.join('\n'), end: i }
}

function readBalanced(text: string, start: number, open: string, close: string): { inner: string; end: number } {
  let depth = 1
  let i = start
  const pending: Heredoc[] = []
  while (i < text.length) {
    const c = text[i]!
    if (c === '\\') {
      i += 2
      continue
    }
    if (c === '<' && text[i + 1] === '<') {
      const heredoc = readHeredocStart(text, i + 2)
      if (heredoc.heredoc) pending.push(heredoc.heredoc)
      i = heredoc.end
      continue
    }
    if (open === '(' && c === '(' && text[i + 1] === '(') {
      const arithmetic = readBalanced(text, i + 2, '(', ')')
      i = text[arithmetic.end] === ')' ? arithmetic.end + 1 : arithmetic.end
      continue
    }
    if (c === '\n' && pending.length > 0) {
      i++
      while (pending.length > 0) i = readHeredocBody(text, i, pending.shift()!).end
      continue
    }
    if (c === "'") {
      const j = text.indexOf("'", i + 1)
      i = j === -1 ? text.length : j + 1
      continue
    }
    if (c === '"') {
      i = skipDoubleQuoted(text, i + 1)
      continue
    }
    if (c === open) depth++
    else if (c === close) {
      depth--
      if (depth === 0) return { inner: text.slice(start, i), end: i + 1 }
    }
    i++
  }
  return { inner: text.slice(start), end: text.length }
}

function skipDoubleQuoted(text: string, from: number): number {
  let i = from
  while (i < text.length) {
    const c = text[i]!
    if (c === '\\' || c === '`') {
      i += 2
      continue
    }
    if (c === '$' && text[i + 1] === '(') {
      i = readBalanced(text, i + 2, '(', ')').end
      continue
    }
    if (c === '"') return i + 1
    i++
  }
  return text.length
}

function readBacktick(text: string, start: number): { inner: string; end: number } {
  let i = start
  let inner = ''
  while (i < text.length) {
    const c = text[i]!
    if (c === '\\' && i + 1 < text.length) {
      inner += text[i + 1]
      i += 2
      continue
    }
    if (c === '`') return { inner, end: i + 1 }
    inner += c
    i++
  }
  return { inner, end: text.length }
}

const ANSI_SIMPLE: Record<string, string> = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', v: '\v' }

function ansiEscape(text: string, at: number): { value: string; end: number } {
  const e = text[at]!
  if (e in ANSI_SIMPLE) return { value: ANSI_SIMPLE[e]!, end: at + 1 }
  const rest = text.slice(at)
  const hex = /^x([0-9a-fA-F]{1,2})/.exec(rest) ?? /^u([0-9a-fA-F]{1,4})/.exec(rest) ?? /^U([0-9a-fA-F]{1,8})/.exec(rest)
  if (hex) return { value: String.fromCodePoint(Math.min(parseInt(hex[1]!, 16), 0x10ffff)), end: at + hex[0].length }
  const oct = /^[0-7]{1,3}/.exec(rest)
  if (oct) return { value: String.fromCharCode(parseInt(oct[0], 8)), end: at + oct[0].length }
  const ctrl = /^c(.)/.exec(rest)
  if (ctrl) return { value: String.fromCharCode(ctrl[1]!.charCodeAt(0) & 0x1f), end: at + 2 }
  return { value: e, end: at + 1 }
}

function substitutionsIn(text: string, dialect: ShellDialect): string[] {
  const found: string[] = []
  let i = 0
  while (i < text.length) {
    const c = text[i]!
    if (c === '\\') {
      i += 2
      continue
    }
    if (c === '$' && text[i + 1] === '(' && text[i + 2] !== '(') {
      const { inner, end } = readBalanced(text, i + 2, '(', ')')
      found.push(inner)
      i = end
      continue
    }
    if (dialect === 'bash' && c === '`') {
      const { inner, end } = readBacktick(text, i + 1)
      found.push(inner)
      i = end
      continue
    }
    i++
  }
  return found
}

function lex(text: string, dialect: ShellDialect): Lexed {
  const tokens: Token[] = []
  const nested: Lexed['nested'] = []
  const pendingHeredocs: Heredoc[] = []
  let word = ''
  let inWord = false
  let expansion = true
  let quoted = false
  let redirectTarget = false
  let afterComma = false
  let i = 0

  const endWord = (): void => {
    if (inWord) {
      const token: Extract<Token, { kind: 'word' }> = { kind: 'word', value: word, expansion: expansion && word.length > 0 }
      if (quoted) token.quoted = true
      if (afterComma) token.listed = true
      if (redirectTarget) token.redirect = true
      tokens.push(token)
      redirectTarget = false
      afterComma = false
    }
    word = ''
    inWord = false
    expansion = true
    quoted = false
  }
  const sep = (): void => {
    endWord()
    redirectTarget = false
    afterComma = false
    if (tokens.length > 0 && tokens[tokens.length - 1]!.kind !== 'sep') tokens.push({ kind: 'sep' })
  }
  const literal = (s: string): void => {
    word += s
    inWord = true
    if (s.length > 0) expansion = false
  }
  const readHeredocBodies = (): void => {
    while (pendingHeredocs.length > 0) {
      const h = pendingHeredocs.shift()!
      const read = readHeredocBody(text, i, h)
      const body = read.body
      i = read.end
      if (!h.quoted) for (const s of substitutionsIn(body, 'bash')) nested.push({ text: s, dialect: 'bash' })
      tokens.push({ kind: 'body', text: body, via: 'heredoc' })
    }
  }

  while (i < text.length) {
    const c = text[i]!
    const next = text[i + 1]

    if (c === '\n') {
      endWord()
      i++
      if (pendingHeredocs.length > 0) readHeredocBodies()
      sep()
      continue
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      endWord()
      i++
      continue
    }
    if (dialect === 'powershell' && c === '<' && next === '#') {
      const close = text.indexOf('#>', i + 2)
      i = close === -1 ? text.length : close + 2
      continue
    }
    if (c === '#' && !inWord) {
      const nl = text.indexOf('\n', i)
      i = nl === -1 ? text.length : nl
      continue
    }
    if (c === "'") {
      if (dialect === 'powershell') {
        let j = i + 1
        let value = ''
        while (j < text.length) {
          if (text[j] === "'" && text[j + 1] === "'") {
            value += "'"
            j += 2
            continue
          }
          if (text[j] === "'") break
          value += text[j]
          j++
        }
        literal(value)
        i = j + 1
        continue
      }
      const j = text.indexOf("'", i + 1)
      literal(j === -1 ? text.slice(i + 1) : text.slice(i + 1, j))
      i = j === -1 ? text.length : j + 1
      continue
    }
    if (dialect === 'bash' && c === '$' && next === "'") {
      let j = i + 2
      let value = ''
      while (j < text.length && text[j] !== "'") {
        if (text[j] === '\\' && j + 1 < text.length) {
          const decoded = ansiEscape(text, j + 1)
          value += decoded.value
          j = decoded.end
          continue
        }
        value += text[j]
        j++
      }
      literal(value)
      i = j + 1
      continue
    }
    if (c === '"') {
      let j = i + 1
      let value = ''
      const escape = dialect === 'powershell' ? '`' : '\\'
      const startJ = j
      let substitutions = 0
      let literalChars = false
      while (j < text.length) {
        const d = text[j]!
        if (d === escape && j + 1 < text.length) {
          value += text[j + 1]
          literalChars = true
          j += 2
          continue
        }
        if (dialect === 'powershell' && d === '"' && text[j + 1] === '"') {
          value += '"'
          literalChars = true
          j += 2
          continue
        }
        if (d === '"') break
        if (d === '$' && text[j + 1] === '(' && text[j + 2] !== '(') {
          const { inner, end } = readBalanced(text, j + 2, '(', ')')
          nested.push({ text: inner, dialect })
          value += inner
          substitutions++
          j = end
          continue
        }
        if (dialect === 'bash' && d === '`') {
          const { inner, end } = readBacktick(text, j + 1)
          nested.push({ text: inner, dialect })
          value += inner
          substitutions++
          j = end
          continue
        }
        value += d
        literalChars = true
        j++
      }
      const rawInner = text.slice(startJ, Math.min(j, text.length))
      const variable = /^\$(\{[^}]*\}|[A-Za-z_]\w*(?::\w+)?|[@*#?$!0-9-])$/.test(rawInner)
      if (!inWord && (variable || (substitutions === 1 && !literalChars))) {
        word = variable ? rawInner : value
        inWord = true
        if (!/^\$(@|\{[^}]*\[@\]\})$/.test(rawInner)) quoted = true
      } else {
        literal(value)
      }
      i = j + 1
      continue
    }
    if (c === '\\' && dialect === 'bash') {
      if (next === '\n') {
        i += 2
        continue
      }
      if (next !== undefined) literal(next)
      i += 2
      continue
    }
    if (c === '`') {
      if (dialect === 'powershell') {
        if (next === '\n') {
          i += 2
          continue
        }
        if (next !== undefined) literal(next)
        i += 2
        continue
      }
      const { inner, end } = readBacktick(text, i + 1)
      nested.push({ text: inner, dialect })
      word += inner
      inWord = true
      i = end
      continue
    }
    if (c === '$') {
      if (next === '(') {
        if (text[i + 2] === '(') {
          const { inner, end } = readBalanced(text, i + 3, '(', ')')
          for (const s of substitutionsIn(inner, dialect)) nested.push({ text: s, dialect })
          i = text[end] === ')' ? end + 1 : end
          literal('0')
          continue
        }
        const { inner, end } = readBalanced(text, i + 2, '(', ')')
        nested.push({ text: inner, dialect })
        word += inner
        inWord = true
        i = end
        continue
      }
      if (next === '{') {
        const close = text.indexOf('}', i + 2)
        const end = close === -1 ? text.length : close + 1
        for (const s of substitutionsIn(text.slice(i + 2, end), dialect)) nested.push({ text: s, dialect })
        word += text.slice(i, end)
        inWord = true
        i = end
        continue
      }
      const m = /^\$(?:[A-Za-z_]\w*(?::\w+)?|[@*#?$!0-9-])/.exec(text.slice(i))
      if (m) {
        word += m[0]
        inWord = true
        i += m[0].length
        continue
      }
      literal('$')
      i++
      continue
    }
    if (dialect === 'bash' && (c === '<' || c === '>') && next === '(') {
      const { inner, end } = readBalanced(text, i + 2, '(', ')')
      nested.push({ text: inner, dialect })
      endWord()
      i = end
      continue
    }
    if (dialect === 'powershell' && c === '@' && (next === "'" || next === '"') && /^\r?\n/.test(text.slice(i + 2))) {
      const closer = `\n${next}@`
      const close = text.indexOf(closer, i + 2)
      const body = (close === -1 ? text.slice(i + 2) : text.slice(i + 2, close)).replace(/^\r?\n/, '').replace(/\r$/, '')
      if (next === '"') for (const s of substitutionsIn(body, 'powershell')) nested.push({ text: s, dialect })
      literal(body)
      i = close === -1 ? text.length : close + closer.length
      continue
    }
    if (dialect === 'bash' && c === '<' && next === '<') {
      endWord()
      if (text[i + 2] === '<') {
        i += 3
        while (text[i] === ' ' || text[i] === '\t') i++
        const m = /^("((?:\\.|[^"\\])*)"|'([^']*)'|([^\s;&|<>()]*))/.exec(text.slice(i)) ?? ['']
        const raw = m[0] ?? ''
        const value = m[2] ?? m[3] ?? m[4] ?? ''
        if (!raw.startsWith("'")) for (const s of substitutionsIn(raw, 'bash')) nested.push({ text: s, dialect: 'bash' })
        tokens.push({ kind: 'body', text: value, via: 'herestring' })
        i += raw.length
        continue
      }
      const heredoc = readHeredocStart(text, i + 2)
      if (heredoc.heredoc) pendingHeredocs.push(heredoc.heredoc)
      i = heredoc.end
      continue
    }
    if (c === '&' && next === '>') {
      endWord()
      i += 2
      if (text[i] === '>') i++
      redirectTarget = true
      continue
    }
    if (c === '<' || c === '>') {
      if (inWord && (/^\d+$/.test(word) || (dialect === 'powershell' && word === '*'))) {
        word = ''
        inWord = false
        expansion = true
      } else {
        endWord()
      }
      i++
      if (text[i] === '>' || text[i] === '|' || text[i] === '<') i++
      if (text[i] === '&' && /[0-9-]/.test(text[i + 1] ?? '')) {
        i++
        while (/[0-9-]/.test(text[i] ?? '')) i++
      } else {
        if (text[i] === '&') i++
        redirectTarget = true
      }
      continue
    }
    if (dialect === 'powershell' && c === ',') {
      endWord()
      afterComma = true
      i++
      continue
    }
    if (dialect === 'bash' && c === '(' && inWord && /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=$/.test(word)) {
      const { inner, end } = readBalanced(text, i + 1, '(', ')')
      for (const s of substitutionsIn(inner, 'bash')) nested.push({ text: s, dialect: 'bash' })
      literal(`(${inner})`)
      i = end
      continue
    }
    if (dialect === 'bash' && c === '(' && next === '(' && !inWord) {
      const { inner, end } = readBalanced(text, i + 2, '(', ')')
      if (/\b(git|gh)\b/i.test(inner)) nested.push({ text: inner, dialect: 'bash' })
      for (const s of substitutionsIn(inner, 'bash')) nested.push({ text: s, dialect: 'bash' })
      i = text[end] === ')' ? end + 1 : end
      literal('0')
      continue
    }
    if (c === '{' && next === '}' && !inWord && (text[i + 2] === undefined || /[\s;|&)]/.test(text[i + 2]!))) {
      literal('{}')
      i += 2
      continue
    }
    if (dialect === 'powershell' && c === '&' && next !== '&' && !inWord && (tokens.length === 0 || tokens[tokens.length - 1]!.kind === 'sep')) {
      literal('&')
      endWord()
      i++
      continue
    }
    if (dialect === 'powershell' && (c === '(' || (c === '@' && next === '('))) {
      endWord()
      if (tokens[tokens.length - 1]?.kind === 'word') {
        const { inner, end } = readBalanced(text, c === '@' ? i + 2 : i + 1, '(', ')')
        nested.push({ text: inner, dialect })
        tokens.push({ kind: 'word', value: inner, expansion: true })
        i = end
        continue
      }
    }
    if (c === ';' || c === '|' || c === '&' || c === '(' || c === ')' || c === '{' || c === '}') {
      sep()
      i++
      continue
    }
    if (dialect === 'powershell' && c === '@' && next === '(') {
      sep()
      i += 2
      continue
    }
    if (dialect === 'powershell' && c === '@' && !inWord && /[A-Za-z_]/.test(next ?? '')) {
      const m = /^@\w+/.exec(text.slice(i))!
      word += m[0]
      inWord = true
      i += m[0].length
      continue
    }
    literal(c)
    i++
  }
  endWord()
  readHeredocBodies()
  return { tokens, nested }
}

function splitCommands(tokens: Token[]): Token[][] {
  const commands: Token[][] = [[]]
  for (const t of tokens) {
    if (t.kind === 'sep') {
      if (commands[commands.length - 1]!.length > 0) commands.push([])
      continue
    }
    commands[commands.length - 1]!.push(t)
  }
  return commands.filter((c) => c.length > 0)
}

type Word = { value: string; expansion: boolean; quoted?: true; listed?: true }

function isVariable(w: Word): boolean {
  return w.expansion && w.value.startsWith('$')
}

function wordsOf(command: Token[]): Word[] {
  return command.filter((t): t is Extract<Token, { kind: 'word' }> => t.kind === 'word' && t.redirect !== true)
}

function splitJoined(words: Word[]): Word[] {
  return words.flatMap((w) => (!w.expansion && /\s/.test(w.value) ? wordsOf(lex(w.value, 'bash').tokens) : [w]))
}

function gitGlobalEnd(args: string[]): number {
  let j = 0
  while (j < args.length) {
    const a = args[j]!
    if (a === '-C' || GIT_VALUE_OPTIONS.has(a)) {
      j += 2
      continue
    }
    if (GIT_GLOBAL_FLAGS.has(a) || /^--[\w-]+=/.test(a)) {
      j++
      continue
    }
    break
  }
  return j
}

function judgeDynamicProgram(after: Word[]): TerminalVerdict {
  const args = after.map((w) => w.value)
  const at = gitGlobalEnd(args)
  const verb = args[at]?.toLowerCase()
  const alias = verb === undefined ? undefined : scanGitOptions(args).aliases[verb]?.replace(/^\s*!/, '')
  const viaAlias = alias !== undefined && (BLOCKED_GIT_VERBS.has(alias.trim().split(/\s+/)[0]!.toLowerCase()) || CODE_GIT_TEXT.test(alias))
  const gitVerb = viaAlias || (verb !== undefined && BLOCKED_GIT_VERBS.has(verb) && !isRecovery(verb, args.slice(at + 1)))
  const ghFirst = args.find((a, k) => !a.startsWith('-') && !GH_VALUE_OPTIONS.has(args[k - 1] ?? ''))
  const ghMerge = ghFirst?.toLowerCase() === 'pr' && isDeny(judgeGh(args, after.map((w) => w.expansion)))
  if (!gitVerb && !ghMerge) return ALLOW
  return deny(`a command name built from a variable or a substitution is followed by '${gitVerb ? args[at] : 'pr merge'}'; the guard cannot read which program that is, so the command was refused — write the program name out`)
}

function startProcessParam(word: string): { kind: 'program' | 'arguments' | 'value' | 'switch'; attached: string | null } | null {
  const m = /^-([A-Za-z]+)(?::(.*))?$/s.exec(word)
  if (!m) return null
  const name = m[1]!.toLowerCase()
  const exact = START_PROCESS_PARAMS.get(name)
  const kinds = exact !== undefined ? [exact] : [...START_PROCESS_PARAMS].filter(([p]) => p.startsWith(name)).map(([, k]) => k)
  return kinds.length === 1 ? { kind: kinds[0]!, attached: m[2] ?? null } : null
}

function judgeStartProcess(after: Word[], ctx: Ctx): TerminalVerdict {
  if (ctx.depth > MAX_DEPTH) return deny('the command nests shells or substitutions too deeply to be read; write it out plainly')
  let program: Word | null = null
  const args: Word[] = []
  let inArguments = false
  for (let k = 0; k < after.length; k++) {
    const w = after[k]!
    if (inArguments && w.listed) {
      args.push(w)
      continue
    }
    const p = w.expansion ? null : startProcessParam(w.value)
    if (p) {
      inArguments = false
      if (p.kind === 'switch') continue
      const value: Word | undefined = p.attached !== null ? { value: p.attached, expansion: false } : after[++k]
      if (value === undefined) continue
      if (p.kind === 'program') program = value
      else if (p.kind === 'arguments') {
        args.push(value)
        inArguments = true
      }
      continue
    }
    inArguments = false
    if (program !== null) args.push(w)
    else program = w
  }
  if (program === null) return ALLOW
  const line = [program, ...splitJoined(args)].map((x): Token => ({ kind: 'word', value: x.value, expansion: x.expansion }))
  return judgeCommandWords(line, 'powershell', ctx)
}

function bodiesOf(command: Token[]): string[] {
  return command.filter((t): t is Extract<Token, { kind: 'body' }> => t.kind === 'body').map((t) => t.text)
}

function judgeText(text: string, dialect: ShellDialect, ctx: Ctx): TerminalVerdict {
  if (ctx.depth > MAX_DEPTH) return deny('the command nests shells or substitutions too deeply to be read; write it out plainly')
  const inner: Ctx = { ...ctx, depth: ctx.depth + 1 }
  const lexed = lex(text, dialect)
  for (const n of lexed.nested) {
    const v = judgeText(n.text, n.dialect, inner)
    if (isDeny(v)) return v
  }
  for (const command of splitCommands(lexed.tokens)) {
    const v = judgeCommandWords(command, dialect, inner)
    if (isDeny(v)) return v
  }
  return ALLOW
}

function judgeCommandWords(command: Token[], dialect: ShellDialect, ctx: Ctx): TerminalVerdict {
  const words = wordsOf(command)
  const bodies = bodiesOf(command)
  const program = words.findIndex((x) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(x.value) && !SHELL_KEYWORDS.has(x.value))
  const runsHere = (i: number): boolean => {
    if (program === -1 || i < program) return false
    for (let k = program; k < i; k++) {
      const x = words[k]!.value
      if (programName(x) === 'command' && /^-[a-zA-Z]*[vV]/.test(words[k + 1]?.value ?? '')) return false
      if (!WRAPPERS.has(programName(x)) && !(k > program && x.startsWith('-'))) return false
    }
    return true
  }
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!
    const name = programName(w.value)
    const rest = words.slice(i + 1).map((x) => x.value)

    if (dialect === 'bash' && w.expansion && !w.quoted && runsHere(i)) {
      return deny(`a command run from an unquoted variable or substitution ('${w.value}') cannot be read: the shell splits it into a whole command line, so the command was refused — write the program name out (or quote the variable when it holds only a program path)`)
    }
    if (w.expansion && rest.length > 0) {
      const v = judgeDynamicProgram(words.slice(i + 1))
      if (isDeny(v)) return v
    }

    let v: TerminalVerdict = ALLOW
    const dashed = w.value.includes('://') ? undefined : /^git-(.+)$/.exec(name)?.[1]
    if (name === 'git') v = judgeGit(rest, ctx, {}, words.slice(i + 1).map((x) => x.expansion))
    else if (dashed !== undefined && BLOCKED_GIT_VERBS.has(dashed)) v = isRecovery(dashed, rest) ? ALLOW : denyGit(dashed)
    else if (name === 'gh') v = judgeGh(rest, words.slice(i + 1).map((x) => x.expansion))
    else if (POSIX_SHELLS.has(name)) v = judgeShellRunner(rest, bodies, ctx)
    else if (POWERSHELLS.has(name)) v = judgePowerShellRunner(rest, words.slice(i + 1).map(isVariable), bodies, ctx, name !== 'pwsh')
    else if (dialect === 'powershell' && START_PROCESS.has(name)) v = judgeStartProcess(words.slice(i + 1), { ...ctx, depth: ctx.depth + 1 })
    else if (name === 'cmd') v = judgeCmdRunner(rest, ctx)
    else if (name === 'wsl') v = judgeWslRunner(rest, ctx)
    else if (DISTRO_LAUNCHERS.test(name) && rest[0]?.toLowerCase() === 'run') v = judgeText(rest.slice(1).join(' '), 'bash', ctx)
    else if (name === 'ssh') v = judgeSshRunner(rest, ctx)
    else if (name === 'su' || name === 'script') v = flagValues(rest, SU_COMMAND_FLAG).map((c) => judgeText(c.text, 'bash', ctx)).find(isDeny) ?? ALLOW
    else if (name === 'eval' && dialect === 'bash' && runsHere(i)) v = judgeText(rest.join(' '), 'bash', ctx)
    else if ((name === 'invoke-expression' || name === 'iex') && dialect === 'powershell' && (i === 0 || ['=', '&', '.'].includes(words[i - 1]!.value))) {
      v = words.slice(i + 1).some(isVariable)
        ? deny('Invoke-Expression with code built from a variable cannot be read, so the command was refused — write the command out')
        : judgeText(rest.join(' '), 'powershell', ctx)
    }
    else if (name === 'env') v = envSplitStrings(rest).map((t) => judgeText(t, 'bash', ctx)).find(isDeny) ?? ALLOW
    else if (name === 'deno' && rest[0] === 'eval') {
      v = words.slice(i + 2).some((x) => x.expansion)
        ? deny('code passed to deno from a variable or a substitution cannot be read, so the command was refused — write the code out')
        : judgeCode(rest.slice(1).join(' '))
    }
    else if (INTERPRETER_FLAGS.has(name)) {
      const flag = INTERPRETER_FLAGS.get(name)!
      const scriptAt = scriptIndex(rest, flag)
      const codes = flagValues(rest, flag, words.slice(i + 1).map((x) => x.expansion))
      if (codes.some((c) => c.dynamic && c.at < scriptAt)) {
        v = deny(`code passed to ${name} from a variable or a substitution cannot be read, so the command was refused — write the code out`)
      } else if (codes.length > 0) v = codes.map((c) => judgeCode(c.text)).find(isDeny) ?? ALLOW
      else {
        const script = rest[scriptAt]
        if (script === undefined || STDIN_SCRIPTS.has(script)) v = bodies.map(judgeCode).find(isDeny) ?? ALLOW
      }
    }
    if (isDeny(v)) return v
  }
  return ALLOW
}

function joinWords(words: string[], dialect: ShellDialect): string {
  return words
    .map((w) => {
      if (w.length > 0 && !/[\s'"\\$`;&|<>(){}#]/.test(w)) return w
      return dialect === 'powershell' ? "'" + w.replace(/'/g, "''") + "'" : "'" + w.replace(/'/g, "'\\''") + "'"
    })
    .join(' ')
}

function flagValues(rest: string[], flag: CodeFlag, dynamic: boolean[] = []): Array<{ text: string; dynamic: boolean; at: number }> {
  const found: Array<{ text: string; dynamic: boolean; at: number }> = []
  for (let k = 0; k < rest.length; k++) {
    const x = rest[k]!
    if (flag.separate.test(x)) found.push({ text: rest[k + 1] ?? '', dynamic: dynamic[k + 1] === true, at: k })
    else {
      const m = flag.attached.exec(x)
      if (m) found.push({ text: m[1]!, dynamic: /^\$(\{[^}]*\}|[A-Za-z_]\w*|[@*#?$!0-9-])$/.test(m[1]!), at: k })
    }
  }
  return found
}

function scriptIndex(rest: string[], flag: CodeFlag): number {
  for (let k = 0; k < rest.length; k++) {
    const x = rest[k]!
    if (x === '-m') return k + 1
    if (flag.separate.test(x) || INTERPRETER_VALUE_OPTIONS.has(x)) {
      k++
      continue
    }
    if (x.startsWith('-')) {
      if (flag.switches && x.length === 2 && !flag.switches.test(x)) k++
      continue
    }
    return k
  }
  return rest.length
}

function envSplitStrings(rest: string[]): string[] {
  const found: string[] = []
  for (let k = 0; k < rest.length; k++) {
    const x = rest[k]!
    if (ENV_SPLIT_FLAG.separate.test(x)) {
      found.push(rest[k + 1] ?? '')
      k++
      continue
    }
    const m = ENV_SPLIT_FLAG.attached.exec(x)
    if (m) found.push(m[1]!)
    else if (/^(-[a-zA-Z0]*[uC]|--unset|--chdir)$/.test(x)) k++
    else if (!x.startsWith('-') && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(x)) break
  }
  return found
}

function judgeCode(code: string): TerminalVerdict {
  const m = CODE_GIT_TEXT.exec(code) ?? CODE_GIT_ARGV.exec(code)
  if (m) return denyGit(m[1]!.toLowerCase())
  if (CODE_GH_MERGE.test(code) || CODE_GH_ARGV.test(code)) return denyGhMerge()
  return ALLOW
}

function denyGit(verb: string): TerminalVerdict {
  const tool = BLOCKED_GIT_VERBS.get(verb) ?? 'the RSCT tools'
  const how =
    tool === 'rsct_request_commit' && verb !== 'commit'
      ? `make the change by editing the files and commit it with ${tool}`
      : `call ${tool} instead — it shows the developer the approval dialog`
  return deny(`\`git ${verb}\` from the terminal is refused: ${how}. If the developer wants to run it by hand, they run it in their own terminal`)
}

function denyGhMerge(): TerminalVerdict {
  return deny('`gh pr merge` from the terminal is refused: the developer merges the pull request on GitHub or in their own terminal')
}

function isRecovery(verb: string, rest: string[]): boolean {
  return RECOVERY_VERBS.has(verb) && rest.length > 0 && rest.every((r) => RECOVERY_FLAGS.has(r))
}

function scanGitOptions(args: string[]): { verbIndex: number; gitDir: string | null; aliases: Record<string, string> } {
  const aliases: Record<string, string> = {}
  let gitDir: string | null = null
  let j = 0
  while (j < args.length) {
    const a = args[j]!
    if (a === '-C') {
      gitDir = args[j + 1] ?? null
      j += 2
      continue
    }
    if (GIT_VALUE_OPTIONS.has(a)) {
      if (a === '-c') {
        const kv = args[j + 1] ?? ''
        const m = /^alias\.([^=]+)=(.*)$/is.exec(kv)
        if (m) aliases[m[1]!.toLowerCase()] = m[2]!
      }
      j += 2
      continue
    }
    if (a.startsWith('-')) {
      j++
      continue
    }
    break
  }
  return { verbIndex: j, gitDir, aliases }
}

function judgeGit(args: string[], ctx: Ctx, inlineAliases: Record<string, string>, dynamic: boolean[] = []): TerminalVerdict {
  const flags = args.map((_, k) => dynamic[k] === true)
  const scan = scanGitOptions(args)
  const aliases = { ...inlineAliases, ...scan.aliases }
  const gitDir = scan.gitDir
  const j = scan.verbIndex
  const verbWord = args[j]
  if (verbWord === undefined) return ALLOW
  if (flags[j]) {
    return deny(`a git subcommand built from a variable or a substitution ('${verbWord}') cannot be read, so the command was refused — write the subcommand out`)
  }
  const verb = verbWord.toLowerCase()
  const rest = args.slice(j + 1)

  if (BLOCKED_GIT_VERBS.has(verb)) {
    if (isRecovery(verb, rest)) return ALLOW
    return denyGit(verb)
  }
  if (verb === 'submodule' && rest[0] === 'foreach') return judgeText(rest.slice(1).filter((r) => !r.startsWith('--')).join(' '), 'bash', ctx)
  if (verb === 'bisect' && rest[0] === 'run') return judgeText(joinWords(rest.slice(1), 'bash'), 'bash', ctx)
  if (GIT_BUILTINS.has(verb)) return ALLOW

  if (ctx.aliasDepth >= MAX_ALIAS_DEPTH) return deny(`the git alias '${verbWord}' expands through too many other aliases to be read; run the full git command`)
  let value: string | undefined = aliases[verb]
  if (value === undefined) {
    const left = ctx.deadline - ctx.now()
    if (left <= 0) return deny(`the git alias '${verbWord}' could not be resolved in time; the command was refused — run the full git command`)
    const found = ctx.resolveAlias(verbWord, gitDir, ctx.cwd, left)
    if ('error' in found) return deny(`the git alias '${verbWord}' could not be resolved (${found.error}); the command was refused — run the full git command`)
    if (!found.found) return ALLOW
    value = found.value
  }
  const deeper: Ctx = { ...ctx, aliasDepth: ctx.aliasDepth + 1 }
  if (value.trimStart().startsWith('!')) return judgeText(value.trimStart().slice(1), 'bash', deeper)
  const expanded = wordsOf(lex(value, 'bash').tokens).map((w) => w.value)
  return judgeGit([...expanded, ...rest], deeper, aliases, [...expanded.map(() => false), ...flags.slice(j + 1)])
}

function judgeGh(args: string[], dynamic: boolean[] = []): TerminalVerdict {
  const flags = args.map((_, k) => dynamic[k] === true)
  const positional: string[] = []
  for (let j = 0; j < args.length; j++) {
    const a = args[j]!
    if (GH_VALUE_OPTIONS.has(a)) {
      j++
      continue
    }
    if (a.startsWith('-')) continue
    if (flags[j] && (positional.length === 0 || positional[0] === 'pr')) {
      return deny(`a gh subcommand built from a variable or a substitution ('${a}') cannot be read, so the command was refused — write the subcommand out`)
    }
    positional.push(a.toLowerCase())
    if (positional.length === 2) {
      if (positional[0] === 'alias' && positional[1] === 'set') {
        const definition = args.slice(j + 1).join(' ')
        if (/\bpr\s+merge\b/i.test(definition) || CODE_GIT_TEXT.test(definition)) {
          return deny('a gh alias that runs `gh pr merge` or a refused git verb is refused: the developer merges the pull request on GitHub or in their own terminal')
        }
      }
      break
    }
  }
  if (positional[0] === 'pr' && positional[1] === 'merge') return denyGhMerge()
  return ALLOW
}

function judgeShellRunner(args: string[], bodies: string[], ctx: Ctx): TerminalVerdict {
  let command = false
  let stdin = false
  for (let j = 0; j < args.length; j++) {
    const a = args[j]!
    if (a.startsWith('--command=')) return judgeText(a.slice('--command='.length), 'bash', ctx)
    if (a === '--command') {
      command = true
      continue
    }
    if (a === '--rcfile' || a === '--init-file') {
      j++
      continue
    }
    if (/^[-+][a-zA-Z]+$/.test(a)) {
      if (a.startsWith('-') && a.includes('c')) command = true
      if (a.startsWith('-') && a.includes('s')) stdin = true
      if (/[oO]/.test(a)) j++
      continue
    }
    if (a.startsWith('-')) continue
    if (command) return judgeText(a, 'bash', ctx)
    if (stdin || STDIN_SCRIPTS.has(a)) break
    return ALLOW
  }
  for (const b of bodies) {
    const v = judgeText(b, 'bash', ctx)
    if (isDeny(v)) return v
  }
  return ALLOW
}

function takesPowerShellValue(arg: string): boolean {
  if (!arg.startsWith('-')) return false
  const name = arg.slice(1)
  if (POWERSHELL_VALUE_ALIASES.has(name)) return true
  return name.length >= 3 && POWERSHELL_VALUE_OPTIONS.some((o) => o.startsWith(name))
}

function judgePowerShellRunner(args: string[], dynamic: boolean[], bodies: string[], ctx: Ctx, bareIsCommand: boolean): TerminalVerdict {
  const command = (from: number): TerminalVerdict =>
    dynamic.slice(from).some(Boolean)
      ? deny('a PowerShell command built from a variable cannot be read, so the command was refused — write the command out')
      : judgeText(args.slice(from).join(' '), 'powershell', ctx)
  for (let j = 0; j < args.length; j++) {
    const a = args[j]!.toLowerCase()
    if (a.length >= 2 && '-command'.startsWith(a)) return command(j + 1)
    if (a.length >= 2 && ('-encodedcommand'.startsWith(a) || a === '-ec' || a === '-enc')) {
      let decoded = ''
      try {
        decoded = Buffer.from(args[j + 1] ?? '', 'base64').toString('utf16le')
      } catch {
        return deny('an encoded PowerShell command could not be decoded, so it was refused')
      }
      if (HOOKS_OFF_KEY.test(decodeUnicodeEscapes(decoded))) return denyHooksOff()
      return judgeText(decoded, 'powershell', ctx)
    }
    if (a === '-file' || a === '-f') break
    if (takesPowerShellValue(a)) {
      j++
      continue
    }
    if (bareIsCommand && !a.startsWith('-')) return command(j)
  }
  for (const b of bodies) {
    const v = judgeText(b, 'powershell', ctx)
    if (isDeny(v)) return v
  }
  return ALLOW
}

function judgeCmdRunner(args: string[], ctx: Ctx): TerminalVerdict {
  const at = args.findIndex((a) => /^\/\/?[ck]$/i.test(a))
  if (at === -1) return ALLOW
  return judgeText(args.slice(at + 1).join(' '), 'bash', ctx)
}

function judgeWslRunner(args: string[], ctx: Ctx): TerminalVerdict {
  let j = 0
  while (j < args.length) {
    const a = args[j]!
    if (a === '-e' || a === '--exec') return judgeText(joinWords(args.slice(j + 1), 'bash'), 'bash', ctx)
    if (a === '--') return judgeText(args.slice(j + 1).join(' '), 'bash', ctx)
    if (WSL_VALUE_OPTIONS.has(a)) {
      j += 2
      continue
    }
    if (a.startsWith('-')) {
      j++
      continue
    }
    return judgeText(args.slice(j).join(' '), 'bash', ctx)
  }
  return ALLOW
}

function judgeSshRunner(args: string[], ctx: Ctx): TerminalVerdict {
  let j = 0
  while (j < args.length) {
    const a = args[j]!
    if (SSH_VALUE_OPTIONS.has(a)) {
      j += 2
      continue
    }
    if (a.startsWith('-')) {
      j++
      continue
    }
    return judgeText(args.slice(j + 1).join(' '), 'bash', ctx)
  }
  return ALLOW
}

function denyHooksOff(): TerminalVerdict {
  return deny('a command that mentions disableAllHooks is refused: switching Claude Code hooks off is the developer\'s own edit')
}

export function defaultAliasResolver(name: string, gitDir: string | null, cwd: string | undefined, timeoutMs: number): AliasLookup {
  const args = [...(gitDir ? ['-C', gitDir] : []), 'config', '--get', `alias.${name}`]
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: Math.max(1, Math.floor(timeoutMs)),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (r.error) return { error: r.error.message }
  if (r.status === 0) return { found: true, value: (r.stdout ?? '').trim() }
  if (r.status === 1) return { found: false }
  return { error: `git config exited ${r.status ?? r.signal}` }
}

export function judgeCommand(text: string, options: JudgeOptions = {}): TerminalVerdict {
  if (HOOKS_OFF_KEY.test(text) || HOOKS_OFF_KEY.test(decodeUnicodeEscapes(text))) return denyHooksOff()
  const now = options.now ?? Date.now
  const ctx: Ctx = {
    depth: 0,
    aliasDepth: 0,
    cwd: options.cwd,
    resolveAlias: options.resolveAlias ?? defaultAliasResolver,
    deadline: now() + (options.aliasBudgetMs ?? DEFAULT_ALIAS_BUDGET_MS),
    now,
  }
  return judgeText(text, options.dialect ?? 'bash', ctx)
}
