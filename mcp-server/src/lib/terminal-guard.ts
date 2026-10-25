import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { basename, dirname, resolve } from 'node:path'
import {
  EXEC_RUNNERS,
  MANAGERS,
  PACKAGE_FILE_NAME,
  defaultPackageLister,
  defaultPackageReader,
  findUp,
  parsePackage,
  planExecRunner,
  planManager,
  repoRoot,
  resolveFolder,
  scriptTexts,
  type Manager,
  type ManagerPlan,
  type PackageLister,
  type PackageReader,
} from './package-scripts.js'

export type ShellDialect = 'bash' | 'powershell'

export type TerminalVerdict = { verdict: 'allow' } | { verdict: 'deny'; reason: string }

export type AliasLookup = { found: true; value: string } | { found: false } | { error: string }

export type AliasResolver = (name: string, gitDir: string | null, cwd: string | undefined, timeoutMs: number) => AliasLookup

export interface JudgeOptions {
  dialect?: ShellDialect
  cwd?: string
  resolveAlias?: AliasResolver
  aliasBudgetMs?: number
  workBudgetMs?: number
  now?: () => number
  readPackage?: PackageReader
  listPackages?: PackageLister
}

const BLOCKED_GIT_VERBS: ReadonlyMap<string, string> = new Map([
  ['commit', 'rsct_request_commit'],
  ['push', 'rsct_request_push'],
  ['merge', 'rsct_request_merge'],
  ['rebase', 'rsct_request_rebase'],
  ['cherry-pick', 'rsct_request_commit'],
  ['revert', 'rsct_request_commit'],
  ['am', 'rsct_request_commit'],
  ['commit-tree', 'rsct_request_commit'],
  ['filter-branch', 'rsct_request_commit'],
  ['fast-import', 'rsct_request_commit'],
  ['quiltimport', 'rsct_request_commit'],
  ['replay', 'rsct_request_rebase'],
  ['pull', 'rsct_request_merge'],
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
const RUNNERS = new Set([...WRAPPERS, 'timeout', 'busybox', 'stdbuf', 'ionice', 'chrt', 'taskset'])
const POWERSHELL_INVOKE = new Set(['&', '.'])

function isRunnerName(name: string, dialect: ShellDialect): boolean {
  return RUNNERS.has(name) || (dialect === 'powershell' && POWERSHELL_INVOKE.has(name))
}
const RUNNER_VALUE_OPTIONS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['sudo', new Set(['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U', '-T', '--user', '--group', '--chdir', '--host', '--prompt', '--role', '--type', '--other-user', '--close-from', '--command-timeout'])],
  ['doas', new Set(['-u', '-C'])],
  ['nice', new Set(['-n', '--adjustment'])],
  ['xargs', new Set(['-I', '-n', '-L', '-P', '-s', '-d', '-E', '-a', '--max-args', '--max-lines', '--max-procs', '--max-chars', '--delimiter', '--eof', '--arg-file', '--process-slot-var'])],
  ['time', new Set(['-o', '-f', '--output', '--format'])],
  ['timeout', new Set(['-s', '-k', '--signal', '--kill-after'])],
  ['env', new Set(['-u', '--unset', '-C', '--chdir', '-S', '--split-string'])],
  ['ionice', new Set(['-c', '-n', '-p', '-P', '-u', '--class', '--classdata'])],
  ['stdbuf', new Set(['-i', '-o', '-e'])],
])
const RUNNER_POSITIONALS: ReadonlyMap<string, number> = new Map([['timeout', 1], ['taskset', 1], ['chrt', 1]])
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
const BASH_QUOTED_ESCAPES = new Set(['$', '`', '"', '\\'])
const BASH_FOLDER_CHANGES = new Set(['cd', 'pushd', 'popd', 'chdir'])
const POWERSHELL_FOLDER_CHANGES = new Set(['cd', 'chdir', 'sl', 'set-location', 'pushd', 'push-location', 'popd', 'pop-location'])
const READ_ONLY_PROGRAMS = new Set([
  'cat', 'head', 'tail', 'less', 'more', 'grep', 'egrep', 'fgrep', 'zgrep', 'rg', 'ag', 'ack', 'jq', 'wc', 'diff', 'cmp',
  'ls', 'dir', 'stat', 'file', 'sha256sum', 'sha1sum', 'sha512sum', 'md5sum', 'shasum', 'cksum', 'echo', 'printf', 'test',
  '[', '[[', 'type', 'realpath', 'readlink', 'basename', 'dirname', 'get-content', 'gc', 'select-string', 'sls', 'test-path',
  'get-item', 'gi', 'get-childitem', 'gci', 'get-filehash', 'write-output', 'write-host', 'convertfrom-json',
])
const GIT_READ_VERBS = new Set(['add', 'diff', 'show', 'log', 'status', 'blame', 'annotate', 'ls-files', 'ls-tree', 'grep', 'check-ignore', 'check-attr', 'cat-file', 'rev-parse', 'shortlog', 'whatchanged'])
const COPY_PROGRAMS = new Set(['cp', 'copy', 'copy-item', 'cpi', 'rsync', 'install', 'ln', 'mv', 'move', 'move-item', 'mi', 'scp'])

const VERBS_PATTERN = 'commit-tree|commit|push|merge|rebase|cherry-pick|revert|am|pull|filter-branch|fast-import|quiltimport|replay'
const VALUE_OPTIONS_PATTERN = ['-C', ...GIT_VALUE_OPTIONS].join('|')
const FLAG_TOKEN = String.raw`-[\w.=:/-]+`
const VALUE_TOKEN = String.raw`(?:"[^"]*"|'[^']*'|[^\s"'])+`
const QUOTE = String.raw`["'\x60]`
const NOT_QUOTE = String.raw`[^"'\x60]`
const CODE_GIT_TEXT = new RegExp(
  String.raw`\bgit(?:\.exe)?\s+(?:${FLAG_TOKEN}\s+|(?<=(?:^|\s)(?:${VALUE_OPTIONS_PATTERN})\s+)(?!${FLAG_TOKEN}\s)${VALUE_TOKEN}\s+)*(${VERBS_PATTERN})(?![\w-])`,
  'i',
)
const CODE_GIT_ARGV = new RegExp(
  String.raw`${QUOTE}git(?:\.exe)?${QUOTE}\s*,\s*(?:\{[^}]*?\bargs\s*:\s*)?(?:\[\s*)?` +
    String.raw`(?:${QUOTE}-${NOT_QUOTE}*${QUOTE}\s*,\s*|(?<=${QUOTE}(?:${VALUE_OPTIONS_PATTERN})${QUOTE}\s*,\s*)(?!${QUOTE}-)(?:${QUOTE}${NOT_QUOTE}*${QUOTE}|[\w.$]+)\s*,\s*)*` +
    String.raw`${QUOTE}(${VERBS_PATTERN})${QUOTE}`,
  'i',
)
const CODE_GH_MERGE = /\bgh(?:\.exe)?\s+(?:-\S+\s+|(?<=(?:^|\s)-\S+\s+)(?!-)\S+\s+)*pr\s+merge\b/i
const CODE_GH_ARGV = new RegExp(
  `["'\`]gh(?:\\.exe)?["'\`]\\s*,\\s*(?:\\[\\s*)?(?:["'\`][^"'\`]*["'\`]\\s*,\\s*)*?["'\`]pr["'\`]\\s*,\\s*(?:["'\`]-[^"'\`]*["'\`]\\s*,\\s*)*["'\`]merge["'\`]`,
  'i',
)
const HOOKS_OFF_KEY = /disableallhooks/i

const MAX_DEPTH = 8
const MAX_ALIAS_DEPTH = 5
const DEFAULT_ALIAS_BUDGET_MS = 3000
const WORK_BUDGET_MS = 5000
export const MAX_COMMAND_BYTES = 64 * 1024
export const MAX_COMMAND_WORDS = 2048
const MAX_FOLDER_LENGTH = 4096

type Token =
  | { kind: 'word'; value: string; expansion: boolean; glob?: true; spliced?: true; quoted?: true; listed?: true; redirect?: true; procsub?: true }
  | { kind: 'sep'; pipe?: true; opens?: number; closes?: number }
  | { kind: 'body'; text: string; via: 'heredoc' | 'herestring' }

interface Lexed {
  tokens: Token[]
  nested: Array<{ text: string; dialect: ShellDialect; piped?: true }>
}

interface Command {
  tokens: Token[]
  piped: boolean
  opens: number
  closes: number
}

interface Folder {
  start: string | undefined
  current: string | undefined
  stack: Array<string | undefined>
}

interface ScriptUnit {
  wrote: Set<string>
  wroteUnknown: boolean
}

interface PackageState {
  read: PackageReader
  list: PackageLister
  memo: Map<string, TerminalVerdict | null>
  bytes: number
}

interface Ctx {
  depth: number
  aliasDepth: number
  cwd: string | undefined
  resolveAlias: AliasResolver
  deadline: number
  workDeadline: number
  now: () => number
  folder: Folder
  unit: ScriptUnit
  pkg: PackageState
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
  let bare = ''
  let spliced = false
  let i = 0
  let parenDepth = 0
  let pendingPipes: Array<Extract<Token, { kind: 'sep' }>> = []

  const endWord = (): void => {
    if (inWord) {
      const pattern = shellPattern(bare, dialect)
      const token: Extract<Token, { kind: 'word' }> = { kind: 'word', value: word, expansion: pattern !== null || (expansion && word.length > 0) }
      if (pattern === 'glob') token.glob = true
      if (spliced) token.spliced = true
      if (quoted) token.quoted = true
      if (afterComma) token.listed = true
      if (redirectTarget) token.redirect = true
      tokens.push(token)
      redirectTarget = false
      afterComma = false
    }
    word = ''
    bare = ''
    spliced = false
    inWord = false
    expansion = true
    quoted = false
  }
  const sep = (): void => {
    endWord()
    redirectTarget = false
    afterComma = false
    pendingPipes = []
    if (tokens.length > 0 && tokens[tokens.length - 1]!.kind !== 'sep') tokens.push({ kind: 'sep' })
  }
  const pipeSep = (): void => {
    endWord()
    redirectTarget = false
    afterComma = false
    const last = tokens[tokens.length - 1]
    if (last === undefined) return
    if (last.kind === 'sep') {
      last.pipe = true
      pendingPipes.push(last)
      return
    }
    const token: Extract<Token, { kind: 'sep' }> = { kind: 'sep', pipe: true }
    tokens.push(token)
    pendingPipes.push(token)
  }
  const markScope = (side: 'opens' | 'closes'): void => {
    if (dialect !== 'bash') return
    const last = tokens[tokens.length - 1]
    if (last?.kind === 'sep') last[side] = (last[side] ?? 0) + 1
    else tokens.push({ kind: 'sep', [side]: 1 })
  }
  const closeParen = (): void => {
    const subshell = parenDepth > 0
    if (subshell) parenDepth--
    else for (const p of pendingPipes) delete p.pipe
    sep()
    if (subshell) markScope('closes')
  }
  const literal = (s: string): void => {
    word += s
    inWord = true
    if (s.length > 0) expansion = false
  }
  const bareChar = (c: string): void => {
    literal(c)
    bare += c
  }
  const splice = (s: string): void => {
    word += s
    inWord = true
    spliced = true
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
          const e = text[j + 1]!
          if (dialect === 'bash' && e === '\n') {
            j += 2
            continue
          }
          if (dialect === 'bash' && !BASH_QUOTED_ESCAPES.has(e)) {
            value += d
            literalChars = true
            j++
            continue
          }
          value += e
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
        if (substitutions > 0 || /\$[\w{(@*#?!$-]/.test(rawInner)) spliced = true
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
      splice(inner)
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
        splice(inner)
        i = end
        continue
      }
      if (next === '{') {
        const close = text.indexOf('}', i + 2)
        const end = close === -1 ? text.length : close + 1
        for (const s of substitutionsIn(text.slice(i + 2, end), dialect)) nested.push({ text: s, dialect })
        splice(text.slice(i, end))
        i = end
        continue
      }
      const m = /^\$(?:[A-Za-z_]\w*(?::\w+)?|[@*#?$!0-9-])/.exec(text.slice(i))
      if (m) {
        splice(m[0])
        i += m[0].length
        continue
      }
      literal('$')
      i++
      continue
    }
    if (dialect === 'bash' && (c === '<' || c === '>') && next === '(') {
      const { inner, end } = readBalanced(text, i + 2, '(', ')')
      nested.push({ text: inner, dialect, ...(c === '>' && { piped: true as const }) })
      endWord()
      if (c === '<') tokens.push({ kind: 'word', value: '/dev/fd/63', expansion: true, procsub: true })
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
        bare = ''
        spliced = false
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
    if (dialect === 'bash' && (c === '{' || c === '}') && (inWord || (next !== undefined && !(c === '{' ? /\s/ : /[\s;|&)<>]/).test(next)))) {
      bareChar(c)
      i++
      continue
    }
    if (c === '|' && next === '|') {
      sep()
      i += 2
      continue
    }
    if (c === '|') {
      pipeSep()
      i += next === '&' ? 2 : 1
      continue
    }
    if (c === ')') {
      closeParen()
      i++
      continue
    }
    if (c === '(') {
      parenDepth++
      sep()
      markScope('opens')
      i++
      continue
    }
    if (c === ';' || c === '&' || c === '{' || c === '}') {
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
    bareChar(c)
    i++
  }
  endWord()
  readHeredocBodies()
  return { tokens, nested }
}

function shellPattern(bare: string, dialect: ShellDialect): 'brace' | 'glob' | null {
  if (dialect === 'bash' && /\{[^{}]*(?:,|\.\.)[^{}]*\}/.test(bare)) return 'brace'
  return /[*?]/.test(bare) || /\[[^\]]+\]/.test(bare) ? 'glob' : null
}

function splitCommands(tokens: Token[], firstPiped = false): Command[] {
  const commands: Command[] = [{ tokens: [], piped: firstPiped, opens: 0, closes: 0 }]
  for (const t of tokens) {
    if (t.kind === 'sep') {
      let current = commands[commands.length - 1]!
      if (current.tokens.length > 0) {
        current.closes += t.closes ?? 0
        current = { tokens: [], piped: t.pipe === true, opens: 0, closes: 0 }
        commands.push(current)
      } else {
        if (t.pipe === true) current.piped = true
        const previous = commands[commands.length - 2]
        if (previous !== undefined) previous.closes += t.closes ?? 0
      }
      current.opens += t.opens ?? 0
      continue
    }
    commands[commands.length - 1]!.tokens.push(t)
  }
  return commands.filter((c) => c.tokens.length > 0)
}

type Word = { value: string; expansion: boolean; glob?: true; spliced?: true; quoted?: true; listed?: true; procsub?: true }

function programPositions(values: string[], program: number, dialect: ShellDialect): { at: boolean[]; xargs: boolean[] } {
  const at: boolean[] = []
  const xargs: boolean[] = []
  if (program === -1) return { at, xargs }
  let viaXargs = false
  let k = program
  while (k < values.length) {
    const name = programName(values[k]!)
    at[k] = true
    xargs[k] = viaXargs
    if (!isRunnerName(name, dialect) || (name === 'command' && /^-[a-zA-Z]*[vV]/.test(values[k + 1] ?? ''))) break
    if (name === 'xargs') viaXargs = true
    const valueOptions = RUNNER_VALUE_OPTIONS.get(name)
    let positionals = RUNNER_POSITIONALS.get(name) ?? 0
    k++
    while (k < values.length) {
      const x = values[k]!
      if (x.startsWith('-') && x !== '-') {
        k += valueOptions?.has(x) ? 2 : 1
        continue
      }
      if (name === 'env' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(x)) {
        k++
        continue
      }
      if (positionals > 0) {
        positionals--
        k++
        continue
      }
      break
    }
  }
  return { at, xargs }
}

const TEXT_ONLY_PROGRAMS = new Set([
  'echo', 'printf', 'cat', 'tee', 'grep', 'egrep', 'fgrep', 'zgrep', 'rg', 'ag', 'ack', 'curl', 'jq', 'yq',
  'write-output', 'write-host', 'select-string', 'set-content', 'add-content', 'out-file', 'invoke-webrequest',
  'invoke-restmethod', 'iwr', 'irm', 'gh', 'glab',
])
const SELF_JUDGED_PROGRAMS = new Set([
  ...POSIX_SHELLS, ...POWERSHELLS, ...INTERPRETER_FLAGS.keys(), 'cmd', 'wsl', 'ssh', 'su', 'script', 'eval', 'env',
  'deno', 'invoke-expression', 'iex', 'start-process', 'saps', 'start', 'source', '.',
])
const SHELL_BUILTINS = new Set(['[', '[[', 'test', 'export', 'declare', 'local', 'readonly', 'typeset', 'set', 'unset', 'alias'])
const FIND_EXEC = new Set(['-exec', '-execdir', '-ok', '-okdir'])

function literalGitVerdict(name: string, args: Word[], bodies: string[], dialect: ShellDialect): TerminalVerdict {
  if (TEXT_ONLY_PROGRAMS.has(name) || SELF_JUDGED_PROGRAMS.has(name) || SHELL_BUILTINS.has(name) || DISTRO_LAUNCHERS.test(name)) return ALLOW
  if (dialect === 'powershell' && (name.startsWith('$') || name.startsWith('-') || name.startsWith("'") || name.startsWith('"'))) return ALLOW
  const values = args.map((a) => a.value)
  if (name === 'git') {
    const configValues: string[] = []
    for (let k = 0; k < values.length; k++) {
      if (values[k] === '-c' || values[k] === '--config-env') configValues.push(values[k + 1] ?? '')
      else if (/^-c./.test(values[k]!)) configValues.push(values[k]!.slice(2))
    }
    const at = gitGlobalEnd(values)
    if (values[at]?.toLowerCase() === 'config') configValues.push(...values.slice(at + 1).filter((v) => !v.startsWith('-')))
    return configValues.map(judgeCode).find(isDeny) ?? ALLOW
  }
  if (name === 'find') {
    for (let k = 0; k < args.length; k++) {
      if (!FIND_EXEC.has(values[k]!)) {
        const v = judgeCode(values[k]!)
        if (isDeny(v)) return v
        continue
      }
      let end = k + 1
      while (end < args.length && values[end] !== ';' && values[end] !== '+') end++
      const span = args.slice(k + 1, end)
      if (span.length > 0) {
        const v = literalGitVerdict(programName(span[0]!.value), span.slice(1), [], dialect)
        if (isDeny(v)) return v
      }
      k = end
    }
    return bodies.map(judgeCode).find(isDeny) ?? ALLOW
  }
  return [...values, ...bodies].map(judgeCode).find(isDeny) ?? ALLOW
}

function denyReader(name: string): TerminalVerdict {
  return deny(`'${name}' here would run commands it reads from a pipe or from another command's output; the guard cannot read them, so the command was refused — write the commands out`)
}

function shellScriptArg(args: Word[]): { code: boolean; stdin: boolean; script: Word | undefined } {
  let code = false
  let stdin = false
  for (let k = 0; k < args.length; k++) {
    const x = args[k]!.value
    if (x === '--') return { code, stdin, script: args[k + 1] }
    if (/^[-+]o$|^[-+]O$/.test(x)) {
      k++
      continue
    }
    if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(x)) code = true
    if (/^-[a-zA-Z]*s[a-zA-Z]*$/.test(x)) stdin = true
    if (x.startsWith('-') || x.startsWith('+')) {
      if (x === '-') return { code, stdin: true, script: undefined }
      continue
    }
    return { code, stdin, script: args[k] }
  }
  return { code, stdin, script: undefined }
}

function execInnerCommand(name: string, args: Word[]): Word[] | null {
  const sub = args[0]?.value
  if ((name === 'docker' || name === 'podman') && (sub === 'exec' || (sub === 'container' && args[1]?.value === 'exec'))) {
    const valueOptions = new Set(['-e', '--env', '--env-file', '-u', '--user', '-w', '--workdir', '--detach-keys'])
    let k = sub === 'exec' ? 1 : 2
    while (k < args.length && args[k]!.value.startsWith('-')) k += valueOptions.has(args[k]!.value) ? 2 : 1
    return args.slice(k + 1)
  }
  if (name === 'kubectl' && sub === 'exec') {
    const dash = args.findIndex((a) => a.value === '--')
    return dash === -1 ? null : args.slice(dash + 1)
  }
  return null
}

function readerVerdict(name: string, args: Word[], dialect: ShellDialect, piped: boolean, viaXargs: boolean): TerminalVerdict {
  const values = args.map((a) => a.value)
  if (POSIX_SHELLS.has(name)) {
    if (piped && viaXargs) return denyReader(name)
    const s = shellScriptArg(args)
    if (s.script?.procsub === true) return denyReader(name)
    if (s.code) return ALLOW
    if (piped && (s.stdin || s.script === undefined || STDIN_SCRIPTS.has(s.script.value))) return denyReader(name)
    return ALLOW
  }
  if (dialect === 'bash' && (name === 'source' || name === '.')) {
    const target = args[0]
    if (target !== undefined && (target.procsub === true || STDIN_SCRIPTS.has(target.value))) return denyReader(name)
    return ALLOW
  }
  if (POWERSHELLS.has(name)) {
    if (!piped) return ALLOW
    const named = values.findIndex((v) => /^-(c|co|com|comm|comma|comman|command|f|fi|fil|file)$/i.test(v))
    if (named !== -1) return values[named + 1] === '-' ? denyReader(name) : ALLOW
    return values.some((v) => !v.startsWith('-')) && !values.includes('-') ? ALLOW : denyReader(name)
  }
  if (name === 'cmd') return piped && !values.some((v) => /^\/[ckCK]$/.test(v)) ? denyReader(name) : ALLOW
  if (dialect === 'powershell' && (name === 'iex' || name === 'invoke-expression')) return piped && values.length === 0 ? denyReader(name) : ALLOW
  if (INTERPRETER_FLAGS.has(name)) {
    const flag = INTERPRETER_FLAGS.get(name)!
    if (flagValues(values, flag).length > 0) return ALLOW
    const at = scriptIndex(values, flag)
    const script = args[at]
    if (script?.procsub === true) return denyReader(name)
    if (piped && (script === undefined || STDIN_SCRIPTS.has(script.value))) return denyReader(name)
    return ALLOW
  }
  if (name === 'at' || name === 'batch') return piped ? denyReader(name) : ALLOW
  if (name === 'su') return piped && !values.some((v) => /^(-[a-zA-Z]*c|--command|--session-command)(=|$)/.test(v)) ? denyReader(name) : ALLOW
  if (name === 'ssh') {
    let k = 0
    while (k < values.length && values[k]!.startsWith('-')) k += SSH_VALUE_OPTIONS.has(values[k]!) ? 2 : 1
    return piped && k + 1 >= values.length ? denyReader(name) : ALLOW
  }
  if (name === 'git' && viaXargs && piped) {
    const at = gitGlobalEnd(values)
    const verb = values[at]
    return verb === undefined || verb.includes('{}') ? denyReader('xargs git') : ALLOW
  }
  const inner = execInnerCommand(name, args)
  if (inner !== null && inner.length > 0) return readerVerdict(programName(inner[0]!.value), inner.slice(1), 'bash', piped, false)
  return ALLOW
}

function isVariable(w: Word): boolean {
  return w.expansion && w.value.startsWith('$')
}

function isDynamicWord(w: Word): boolean {
  return w.expansion || w.spliced === true
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

function mayNameGatedVerb(next: string): boolean {
  const lower = next.toLowerCase()
  return next.startsWith('-') || BLOCKED_GIT_VERBS.has(lower) || lower === 'pr'
}

function judgeDynamicProgram(after: Word[]): TerminalVerdict {
  const args = after.map((w) => w.value)
  const at = gitGlobalEnd(args)
  const verb = args[at]?.toLowerCase()
  const alias = verb === undefined ? undefined : scanGitOptions(args).aliases[verb]?.replace(/^\s*!/, '')
  const viaAlias = alias !== undefined && (BLOCKED_GIT_VERBS.has(alias.trim().split(/\s+/)[0]!.toLowerCase()) || CODE_GIT_TEXT.test(alias))
  const gitVerb = viaAlias || (verb !== undefined && BLOCKED_GIT_VERBS.has(verb) && !isAllowedForm(verb, args.slice(0, at), args.slice(at + 1), after.slice(at + 1).map(isDynamicWord)))
  const ghFirst = args.find((a, k) => !a.startsWith('-') && !GH_VALUE_OPTIONS.has(args[k - 1] ?? ''))
  const ghMerge = ghFirst?.toLowerCase() === 'pr' && isDeny(judgeGh(args, after.map(isDynamicWord)))
  if (!gitVerb && !ghMerge) return ALLOW
  return deny(`a command name built from a variable, a substitution or a brace or glob pattern is followed by '${gitVerb ? args[at] : 'pr merge'}'; the guard cannot read which program that is, so the command was refused — write the program name out`)
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
  const line = [program, ...splitJoined(args)].map((x): Token => ({ kind: 'word', value: x.value, expansion: x.expansion, ...(x.spliced ? { spliced: true as const } : {}) }))
  return judgeCommandWords(line, 'powershell', ctx)
}

function bodiesOf(command: Token[]): string[] {
  return command.filter((t): t is Extract<Token, { kind: 'body' }> => t.kind === 'body').map((t) => t.text)
}

function judgeText(text: string, dialect: ShellDialect, ctx: Ctx, firstPiped = false): TerminalVerdict {
  if (ctx.depth > MAX_DEPTH) return deny('the command nests shells or substitutions too deeply to be read; write it out plainly')
  const here = ctx.folder.current
  const inner: Ctx = { ...ctx, depth: ctx.depth + 1, folder: { start: here, current: here, stack: [] } }
  const lexed = lex(text, dialect)
  for (const n of lexed.nested) {
    const v = judgeText(n.text, n.dialect, inner, n.piped === true)
    if (isDeny(v)) return v
  }
  const commands = splitCommands(lexed.tokens, firstPiped)
  const saved: Array<string | undefined> = []
  for (let k = 0; k < commands.length; k++) {
    const command = commands[k]!
    for (let n = 0; n < command.opens; n++) saved.push(inner.folder.current)
    const before = inner.folder.current
    const v = judgeCommandWords(command.tokens, dialect, inner, command.piped)
    if (isDeny(v)) return v
    if (dialect === 'bash' && (command.piped || commands[k + 1]?.piped === true)) inner.folder.current = before
    for (let n = 0; n < command.closes && saved.length > 0; n++) inner.folder.current = saved.pop()
  }
  return ALLOW
}

function judgeCommandWords(command: Token[], dialect: ShellDialect, ctx: Ctx, piped = false): TerminalVerdict {
  const words = wordsOf(command)
  if (words.length > MAX_COMMAND_WORDS) {
    return deny(`a single command with more than ${MAX_COMMAND_WORDS} words is refused: the guard cannot judge it in time. Split it into shorter commands, or write long input to a file with the Write tool`)
  }
  const bodies = bodiesOf(command)
  const values = words.map((x) => x.value)
  const dynamic = words.map(isDynamicWord)
  const program = words.findIndex((x) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(x.value) && !SHELL_KEYWORDS.has(x.value))
  const runsHere: boolean[] = []
  let chain = program !== -1
  for (let k = 0; k < words.length; k++) {
    runsHere.push(chain && k >= program)
    if (k < program) continue
    const x = values[k]!
    if (programName(x) === 'command' && /^-[a-zA-Z]*[vV]/.test(values[k + 1] ?? '')) chain = false
    else if (!WRAPPERS.has(programName(x)) && !(k > program && x.startsWith('-'))) chain = false
  }
  const runner = programPositions(values, program, dialect)
  recordPackageWrites(command, values, bodies, runner.at, ctx)
  for (let i = 0; i < words.length; i++) {
    if (ctx.now() > ctx.workDeadline) return denySlow()
    const w = words[i]!
    const name = programName(w.value)
    let restCache: string[] | null = null
    const rest = (): string[] => (restCache ??= values.slice(i + 1))
    const restDynamic = (): boolean[] => dynamic.slice(i + 1)

    if (dialect === 'bash' && w.expansion && !w.quoted && w.glob !== true && (runsHere[i] || runner.at[i] === true)) {
      return deny(`a command run from an unquoted variable, substitution or brace or glob pattern ('${w.value}') cannot be read: the shell splits it into a whole command line, so the command was refused — write the program name out (or quote the variable when it holds only a program path)`)
    }
    if (runner.at[i] === true && !isRunnerName(name, dialect)) {
      const after = words.slice(i + 1)
      const reader = readerVerdict(name, after, dialect, piped, runner.xargs[i] === true)
      if (isDeny(reader)) return reader
      const literal = literalGitVerdict(name, after, bodies, dialect)
      if (isDeny(literal)) return literal
      const call = managerCall(name, after)
      if (call !== null) {
        const v = judgeManager(call, ctx, piped)
        if (isDeny(v)) return v
      }
      if ((dialect === 'bash' ? BASH_FOLDER_CHANGES : POWERSHELL_FOLDER_CHANGES).has(name)) changeFolder(name, after, dialect, ctx.folder)
    }
    if (w.expansion && i + 1 < words.length && mayNameGatedVerb(values[i + 1]!)) {
      const v = judgeDynamicProgram(words.slice(i + 1))
      if (isDeny(v)) return v
    }

    let v: TerminalVerdict = ALLOW
    const dashed = w.value.includes('://') ? undefined : /^git-(.+)$/.exec(name)?.[1]
    if (name === 'git') v = judgeGit(rest(), ctx, {}, restDynamic())
    else if (dashed !== undefined && BLOCKED_GIT_VERBS.has(dashed)) v = isAllowedForm(dashed, [], rest(), restDynamic()) ? ALLOW : denyGit(dashed)
    else if (name === 'gh') v = judgeGh(rest(), restDynamic())
    else if (POSIX_SHELLS.has(name)) v = judgeShellRunner(rest(), bodies, ctx)
    else if (POWERSHELLS.has(name)) v = judgePowerShellRunner(rest(), words.slice(i + 1).map(isVariable), bodies, ctx, name !== 'pwsh')
    else if (dialect === 'powershell' && START_PROCESS.has(name)) v = judgeStartProcess(words.slice(i + 1), { ...ctx, depth: ctx.depth + 1 })
    else if (name === 'cmd') v = judgeCmdRunner(rest(), ctx)
    else if (name === 'wsl') v = judgeWslRunner(rest(), ctx)
    else if (DISTRO_LAUNCHERS.test(name) && values[i + 1]?.toLowerCase() === 'run') v = judgeText(rest().slice(1).join(' '), 'bash', ctx)
    else if (name === 'ssh') v = judgeSshRunner(rest(), ctx)
    else if (name === 'su' || name === 'script') v = flagValues(rest(), SU_COMMAND_FLAG).map((c) => judgeText(c.text, 'bash', ctx)).find(isDeny) ?? ALLOW
    else if (name === 'eval' && dialect === 'bash' && runsHere[i]) v = judgeText(rest().join(' '), 'bash', ctx)
    else if ((name === 'invoke-expression' || name === 'iex') && dialect === 'powershell' && (i === 0 || ['=', '&', '.'].includes(values[i - 1]!))) {
      v = words.slice(i + 1).some(isVariable)
        ? deny('Invoke-Expression with code built from a variable cannot be read, so the command was refused — write the command out')
        : judgeText(rest().join(' '), 'powershell', ctx)
    }
    else if (name === 'env') v = envSplitStrings(rest()).map((t) => judgeText(t, 'bash', ctx)).find(isDeny) ?? ALLOW
    else if (name === 'deno' && values[i + 1] === 'eval') {
      v = words.slice(i + 2).some((x) => x.expansion)
        ? deny('code passed to deno from a variable or a substitution cannot be read, so the command was refused — write the code out')
        : judgeCode(rest().slice(1).join(' '))
    }
    else if (INTERPRETER_FLAGS.has(name)) {
      const flag = INTERPRETER_FLAGS.get(name)!
      const scriptAt = scriptIndex(rest(), flag)
      const codes = flagValues(rest(), flag, words.slice(i + 1).map((x) => x.expansion))
      if (codes.some((c) => c.dynamic && c.at < scriptAt)) {
        v = deny(`code passed to ${name} from a variable or a substitution cannot be read, so the command was refused — write the code out`)
      } else if (codes.length > 0) v = codes.map((c) => judgeCode(c.text)).find(isDeny) ?? ALLOW
      else {
        const script = rest()[scriptAt]
        if (script === undefined || STDIN_SCRIPTS.has(script)) v = bodies.map(judgeCode).find(isDeny) ?? ALLOW
      }
    }
    if (isDeny(v)) return v
  }
  return ALLOW
}

function changeFolder(name: string, args: Word[], dialect: ShellDialect, folder: Folder): void {
  if (name === 'popd' || name === 'pop-location') {
    if (folder.stack.length > 0) folder.current = folder.stack.pop()
    return
  }
  let target: Word | undefined
  for (let k = 0; k < args.length; k++) {
    const a = args[k]!.value
    if (a === '--') {
      target = args[k + 1]
      break
    }
    if (a.startsWith('-') && a !== '-') {
      if (dialect === 'powershell' && /^-stackname$/i.test(a)) k++
      continue
    }
    target = args[k]
    break
  }
  if (name === 'pushd' || name === 'push-location') folder.stack.push(folder.current)
  if (target === undefined) {
    if (name === 'pushd') folder.current = undefined
    else if (name !== 'push-location') folder.current = homedir()
  } else if (target.value === '-' || isDynamicWord(target)) folder.current = undefined
  else {
    const next = resolveFolder(folder.current, target.value)
    folder.current = next !== undefined && next.length <= MAX_FOLDER_LENGTH ? next : undefined
  }
}

function copyDestination(args: string[]): string {
  const flag = args.findIndex((a) => /^-(destination|t)$/i.test(a) || a === '--target-directory')
  if (flag !== -1) return args[flag + 1] ?? ''
  const attached = args.find((a) => a.startsWith('--target-directory='))
  if (attached !== undefined) return attached.slice('--target-directory='.length)
  const positional = args.filter((a) => !a.startsWith('-'))
  return positional[positional.length - 1] ?? ''
}

function recordWrite(ctx: Ctx, rel: string | undefined): void {
  const folder = rel === undefined ? ctx.folder.current : resolveFolder(ctx.folder.current, rel)
  if (folder === undefined) ctx.unit.wroteUnknown = true
  else ctx.unit.wrote.add(folder)
}

function recordPackageWrites(command: Token[], values: string[], bodies: string[], at: boolean[], ctx: Ctx): void {
  for (const t of command) {
    if (t.kind === 'word' && t.redirect === true && PACKAGE_FILE_NAME.test(t.value)) recordWrite(ctx, dirname(t.value))
  }
  const main = at.lastIndexOf(true)
  if (main === -1) return
  const args = values.slice(main + 1)
  const inBodies = bodies.some((b) => PACKAGE_FILE_NAME.test(b))
  const named = args.find((a) => PACKAGE_FILE_NAME.test(a))
  if (!inBodies && named === undefined) return
  const name = programName(values[main]!)
  if (READ_ONLY_PROGRAMS.has(name) || MANAGERS.has(name) || EXEC_RUNNERS.has(name)) return
  if (name === 'git' && GIT_READ_VERBS.has(args[gitGlobalEnd(args)]?.toLowerCase() ?? '')) return
  if (COPY_PROGRAMS.has(name)) {
    if (inBodies) return
    const dest = copyDestination(args)
    recordWrite(ctx, PACKAGE_FILE_NAME.test(basename(dest)) ? dirname(dest) : dest)
    return
  }
  recordWrite(ctx, inBodies || named === undefined ? undefined : dirname(named))
}

function wroteInto(ctx: Ctx, folder: string): boolean {
  return ctx.unit.wroteUnknown || ctx.unit.wrote.has(folder)
}

type ManagerCall = { manager: Manager; args: Word[]; exec: boolean }

function managerCall(name: string, after: Word[]): ManagerCall | null {
  const manager = MANAGERS.get(name)
  if (manager !== undefined) return { manager, args: after, exec: false }
  if (EXEC_RUNNERS.has(name)) return { manager: 'npm', args: after, exec: true }
  if (name === 'corepack' && after[0] !== undefined) {
    const inner = MANAGERS.get(programName(after[0].value).replace(/@.*$/, ''))
    if (inner !== undefined) return { manager: inner, args: after.slice(1), exec: false }
  }
  if (name === 'php') {
    const at = scriptIndex(after.map((w) => w.value), INTERPRETER_FLAGS.get('php')!)
    const script = after[at]
    if (script !== undefined && MANAGERS.get(programName(script.value)) === 'composer') return { manager: 'composer', args: after.slice(at + 1), exec: false }
  }
  return null
}

function wordToken(w: Word): Token {
  return {
    kind: 'word',
    value: w.value,
    expansion: w.expansion,
    ...(w.spliced ? { spliced: true as const } : {}),
    ...(w.quoted ? { quoted: true as const } : {}),
    ...(w.glob ? { glob: true as const } : {}),
  }
}

function judgeManager(call: ManagerCall, ctx: Ctx, piped: boolean): TerminalVerdict {
  const values = call.args.map((w) => w.value)
  const plan: ManagerPlan | null = call.exec ? null : planManager(call.manager, values)
  const exec = plan ?? planExecRunner(values)
  for (const code of exec.execCode) {
    if (isDynamicWord(call.args[code.at]!)) return deny('code passed to a package manager from a variable or a substitution cannot be read, so the command was refused — write the code out')
    const v = judgeText(code.value, 'bash', ctx)
    if (isDeny(v)) return v
  }
  if (exec.execAt !== null && !isDynamicWord(call.args[exec.execAt]!)) {
    const v = judgeCommandWords(call.args.slice(exec.execAt).map(wordToken), 'bash', { ...ctx, depth: ctx.depth + 1 }, piped)
    if (isDeny(v)) return v
  }
  if (plan === null) return ALLOW
  if (plan.versionCommit) return denyVersion(call.manager)
  const base = ctx.folder.current ?? ctx.folder.start
  if (plan.writesPackage) {
    recordWrite(ctx, base === undefined ? undefined : '.')
    return ALLOW
  }
  if (plan.global) return ALLOW
  if (plan.nameAt.some((at) => isDynamicWord(call.args[at]!))) {
    return deny('a package script named by a variable or a substitution cannot be read, so the command was refused — write the script name out')
  }
  if (plan.names.length === 0) return ALLOW
  const options = plan.folders.filter((f) => !isDynamicWord(call.args[f.at]!))
  const dirs = options.length === 0 ? [base] : options.map((f) => resolveFolder(base, f.value))
  for (const dir of new Set(dirs)) {
    if (dir === undefined) continue
    const v = judgePackageScripts(call.manager, plan, dir, ctx)
    if (isDeny(v)) return v
  }
  return ALLOW
}

function judgePackageScripts(manager: Manager, plan: ManagerPlan, dir: string, ctx: Ctx): TerminalVerdict {
  if (ctx.now() > ctx.workDeadline) return denySlow()
  if (wroteInto(ctx, resolve(dir))) return denyWriteThenRun()
  const found = findUp(dir, plan.file, ctx.pkg.read)
  if (found === null) return ALLOW
  if (wroteInto(ctx, dirname(found.path))) return denyWriteThenRun()
  const first = parsePackage(found.path, found.read)
  if (!first.ok) return denyPackage(first.reason)
  const files = [{ path: found.path, json: first.json }]
  if (plan.workspaces) {
    const root = repoRoot(dirname(found.path), ctx.pkg.read) ?? dirname(found.path)
    const listing = ctx.pkg.list(root, plan.file)
    if (!listing.complete) {
      return deny(`this command runs a package script in every workspace, and ${root} holds more package files than the guard reads, so it was refused — run the script in one package, or the developer runs it`)
    }
    for (const path of listing.files) {
      if (resolve(path) === resolve(found.path)) continue
      if (ctx.now() > ctx.workDeadline) return denySlow()
      const read = ctx.pkg.read(path)
      if (read.kind === 'missing') continue
      const parsed = parsePackage(path, read)
      if (!parsed.ok) return denyPackage(parsed.reason)
      files.push({ path, json: parsed.json })
    }
  }
  for (const f of files) {
    for (const name of plan.names) {
      const v = judgeScriptName(manager, f.path, f.json, name, ctx)
      if (isDeny(v)) return v
    }
  }
  return ALLOW
}

function judgeScriptName(manager: Manager, path: string, json: Record<string, unknown>, name: string, ctx: Ctx): TerminalVerdict {
  const key = `${path}\u0000${name}`
  if (ctx.pkg.memo.has(key)) return ctx.pkg.memo.get(key) ?? ALLOW
  const texts = scriptTexts(manager, json, name)
  if (texts.length === 0) return ALLOW
  ctx.pkg.memo.set(key, null)
  const v = judgeScriptTexts(texts, dirname(path), ctx)
  const verdict = isDeny(v) ? deny(`the ${basename(path)} script '${name}' that this command runs is refused (${path}): ${v.reason}`) : ALLOW
  ctx.pkg.memo.set(key, verdict)
  return verdict
}

function judgeScriptTexts(texts: string[], dir: string, ctx: Ctx): TerminalVerdict {
  for (const text of texts) {
    ctx.pkg.bytes += Buffer.byteLength(text, 'utf8')
    if (ctx.pkg.bytes > MAX_COMMAND_BYTES) {
      return deny(`the command and the package scripts it runs are over ${MAX_COMMAND_BYTES / 1024} KiB together, too long to judge in time; the developer runs it`)
    }
    const unit: ScriptUnit = { wrote: new Set(), wroteUnknown: false }
    const scriptCtx: Ctx = { ...ctx, unit, folder: { start: dir, current: dir, stack: [] } }
    for (const variant of text.includes('^') ? [text, text.replace(/\^(.)/gs, '$1')] : [text]) {
      const v = judgeText(variant, 'bash', scriptCtx)
      if (isDeny(v)) return v
    }
  }
  return ALLOW
}

function denyVersion(manager: Manager): TerminalVerdict {
  return deny(`\`${manager} version\` with a new version commits and tags with git, so it is refused from the terminal: add --no-git-tag-version and commit with rsct_request_commit, or the developer runs it in their own terminal`)
}

function denyPackage(reason: string): TerminalVerdict {
  return deny(`the package file this command runs scripts from could not be read (${reason}), so the command was refused — fix the file, or the developer runs the command`)
}

function denyWriteThenRun(): TerminalVerdict {
  return deny('this command changes a package file and runs package scripts in the same go; the guard reads the scripts before anything runs, so it cannot judge the changed ones — make the change and run the scripts in separate commands')
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
  if (verb === 'pull') {
    return deny('`git pull` from the terminal is refused unless it is fast-forward only: a pull that merges or rebases creates commits only the developer approves. Run `git pull --ff-only` or `git fetch`; if the branches diverged, ask the developer')
  }
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

function isAllowedForm(verb: string, globals: string[], rest: string[], restDynamic: boolean[] = []): boolean {
  if (verb === 'pull') return isSafePull(globals, rest, restDynamic)
  return RECOVERY_VERBS.has(verb) && rest.length > 0 && rest.every((r) => RECOVERY_FLAGS.has(r))
}

const PULL_SAFE_FLAGS = new Set(['--ff-only', '-q', '--quiet', '-v', '--verbose', '--prune', '-p', '--no-rebase', '--rebase=false', '--tags', '--no-tags', '--stat', '--no-stat', '-n'])
const PULL_CONFIG = /^(?:pull|branch|rebase)\./i

function isSafePull(globals: string[], rest: string[], restDynamic: boolean[]): boolean {
  for (let k = 0; k < globals.length; k++) {
    const g = globals[k]!
    if (g === '-c' && PULL_CONFIG.test(globals[k + 1] ?? '')) return false
    if (g.startsWith('-c') && g.length > 2 && PULL_CONFIG.test(g.slice(2))) return false
  }
  if (restDynamic.some(Boolean) || !rest.includes('--ff-only')) return false
  let positional = 0
  for (const r of rest) {
    if (r.startsWith('-')) {
      if (!PULL_SAFE_FLAGS.has(r)) return false
      continue
    }
    positional += 1
    if (positional === 1 && isLocalRepository(r)) return false
  }
  return true
}

function isLocalRepository(r: string): boolean {
  return r === '.' || r === '..' || /^\.{1,2}[\\/]/.test(r) || /^[\\/]/.test(r) || /^[A-Za-z]:/.test(r) || /^file:/i.test(r)
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
    return deny(`a git subcommand built from a variable, a substitution or a brace or glob pattern ('${verbWord}') cannot be read, so the command was refused — write the subcommand out`)
  }
  const verb = verbWord.toLowerCase()
  const rest = args.slice(j + 1)

  if (BLOCKED_GIT_VERBS.has(verb)) {
    if (isAllowedForm(verb, args.slice(0, j), rest, flags.slice(j + 1))) return ALLOW
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
  return judgeGit([...args.slice(0, j), ...expanded, ...rest], deeper, aliases, [...flags.slice(0, j), ...expanded.map(() => false), ...flags.slice(j + 1)])
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
      return deny(`a gh subcommand built from a variable, a substitution or a brace or glob pattern ('${a}') cannot be read, so the command was refused — write the subcommand out`)
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
  if (Buffer.byteLength(text, 'utf8') > MAX_COMMAND_BYTES) {
    return deny(`a command over ${MAX_COMMAND_BYTES / 1024} KiB is refused: the guard cannot judge it in time. Write long text to a file with the Write tool and run a short command`)
  }
  if (HOOKS_OFF_KEY.test(text) || HOOKS_OFF_KEY.test(decodeUnicodeEscapes(text))) return denyHooksOff()
  const now = options.now ?? Date.now
  const start = now()
  const ctx: Ctx = {
    depth: 0,
    aliasDepth: 0,
    cwd: options.cwd,
    resolveAlias: options.resolveAlias ?? defaultAliasResolver,
    deadline: start + (options.aliasBudgetMs ?? DEFAULT_ALIAS_BUDGET_MS),
    workDeadline: start + (options.workBudgetMs ?? WORK_BUDGET_MS),
    now,
    folder: { start: options.cwd, current: options.cwd, stack: [] },
    unit: { wrote: new Set(), wroteUnknown: false },
    pkg: {
      read: options.readPackage ?? defaultPackageReader,
      list: options.listPackages ?? defaultPackageLister,
      memo: new Map(),
      bytes: Buffer.byteLength(text, 'utf8'),
    },
  }
  return judgeText(text, options.dialect ?? 'bash', ctx)
}

function denySlow(): TerminalVerdict {
  return deny('the guard could not finish judging this command in time, so it was refused. Split it into shorter commands')
}
