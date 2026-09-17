import { posix } from 'node:path'

export type SweepLanguage =
  | 'javascript'
  | 'typescript'
  | 'tsx'
  | 'java'
  | 'python'
  | 'php'
  | 'css'
  | 'html'
  | 'sql'

export type LanguageBucket =
  | { bucket: 'supported'; language: SweepLanguage }
  | { bucket: 'unsupported'; language: string }
  | { bucket: 'not_code' }
  | { bucket: 'unknown' }

const SUPPORTED_EXTENSIONS: Readonly<Record<string, SweepLanguage>> = {
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascript',
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'tsx',
  '.java': 'java',
  '.py': 'python',
  '.pyw': 'python',
  '.pyi': 'python',
  '.php': 'php',
  '.phtml': 'php',
  '.css': 'css',
  '.html': 'html',
  '.htm': 'html',
  '.xhtml': 'html',
  '.sql': 'sql',
  '.pgsql': 'sql',
  '.ddl': 'sql',
}

const UNSUPPORTED_EXTENSIONS: ReadonlySet<string> = new Set([
  '.sh', '.bash', '.zsh', '.go', '.rb', '.kt', '.kts', '.cs', '.c', '.h', '.cpp', '.hpp',
  '.rs', '.swift', '.scala', '.lua', '.ps1', '.psm1', '.vue', '.svelte', '.scss', '.sass',
  '.less', '.inc', '.pl', '.r', '.dart', '.ex', '.exs', '.erl', '.clj', '.groovy',
])

const NOT_CODE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.md', '.markdown', '.mdx', '.template', '.txt', '.json', '.jsonc', '.lock', '.yml', '.yaml',
  '.toml', '.ini', '.properties', '.env', '.xml', '.gradle', '.csv', '.tsv', '.svg', '.png',
  '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.woff', '.woff2', '.ttf', '.eot', '.wasm',
  '.zip', '.gz', '.map', '.log', '.gitkeep', '.keep',
])

const NOT_CODE_BASENAMES: ReadonlySet<string> = new Set([
  'license', 'notice', 'dockerfile', 'makefile', '.gitignore', '.gitattributes', '.editorconfig',
  '.npmrc', '.nvmrc',
])

const SHEBANG_INTERPRETERS: ReadonlyArray<readonly [RegExp, LanguageBucket]> = [
  [/^(node|nodejs|deno|bun)$/, { bucket: 'supported', language: 'javascript' }],
  [/^(ts-node|tsx)$/, { bucket: 'supported', language: 'typescript' }],
  [/^python[0-9.]*$/, { bucket: 'supported', language: 'python' }],
  [/^php[0-9.]*$/, { bucket: 'supported', language: 'php' }],
  [/^(sh|bash|zsh|dash|ksh)$/, { bucket: 'unsupported', language: 'shell' }],
  [/^(ruby|perl|lua|pwsh)$/, { bucket: 'unsupported', language: 'script' }],
]

function extensionOf(path: string): string {
  const base = posix.basename(path.replace(/\\/g, '/')).toLowerCase()
  if (base.endsWith('.d.ts')) return '.ts'
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot)
}

function shebangBucket(firstLine: string): LanguageBucket | null {
  const line = firstLine.replace(/^﻿/, '').replace(/\r$/, '')
  if (!line.startsWith('#!')) return null
  const parts = line.slice(2).trim().split(/\s+/)
  let interpreter = posix.basename(parts[0] ?? '')
  if (interpreter === 'env') {
    const next = parts.slice(1).find((p) => !p.startsWith('-'))
    interpreter = next ?? ''
  }
  for (const [pattern, bucket] of SHEBANG_INTERPRETERS) {
    if (pattern.test(interpreter)) return bucket
  }
  return { bucket: 'unsupported', language: interpreter || 'unknown' }
}

export function classifyPath(path: string, firstLine: string | null): LanguageBucket {
  const base = posix.basename(path.replace(/\\/g, '/')).toLowerCase()
  if (NOT_CODE_BASENAMES.has(base)) return { bucket: 'not_code' }
  const ext = extensionOf(path)
  const supported = SUPPORTED_EXTENSIONS[ext]
  if (supported) return { bucket: 'supported', language: supported }
  if (UNSUPPORTED_EXTENSIONS.has(ext)) return { bucket: 'unsupported', language: ext.slice(1) }
  if (NOT_CODE_EXTENSIONS.has(ext)) return { bucket: 'not_code' }
  if (ext === '' && firstLine !== null) {
    const fromShebang = shebangBucket(firstLine)
    if (fromShebang) return fromShebang
  }
  return { bucket: 'unknown' }
}
