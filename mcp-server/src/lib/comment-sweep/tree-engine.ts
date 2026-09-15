import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Language, Parser } from 'web-tree-sitter'

export type TreeLanguage = 'javascript' | 'typescript' | 'tsx' | 'java' | 'python' | 'php' | 'css'

export interface TreeComment {
  start: number
  end: number
}

export interface TreeText {
  start: number
  end: number
}

export type TreeScan =
  | { ok: true; comments: TreeComment[]; texts: TreeText[] }
  | { ok: false; reason: 'parse_error' | 'engine_unavailable' }

const GRAMMAR_FILES: Readonly<Record<TreeLanguage, string>> = {
  javascript: 'tree-sitter-javascript.wasm',
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  java: 'tree-sitter-java.wasm',
  python: 'tree-sitter-python.wasm',
  php: 'tree-sitter-php.wasm',
  css: 'tree-sitter-css.wasm',
}

const RUNTIME_FILE = 'tree-sitter.wasm'
const MANIFEST_FILE = 'manifest.json'

export function locateGrammarsDir(start: string = dirname(fileURLToPath(import.meta.url))): string | null {
  let dir = start
  for (let depth = 0; depth < 6; depth++) {
    const candidate = join(dir, 'grammars')
    if (existsSync(join(candidate, MANIFEST_FILE))) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

const wasm = (globalThis as unknown as { WebAssembly: { validate(bytes: Uint8Array): boolean } }).WebAssembly

let runtime: Promise<boolean> | null = null
const languages = new Map<TreeLanguage, Promise<Language | null>>()

function readWasm(path: string): Uint8Array | null {
  try {
    const bytes = new Uint8Array(readFileSync(path))
    return wasm.validate(bytes) ? bytes : null
  } catch {
    return null
  }
}

function initRuntime(grammarsDir: string): Promise<boolean> {
  if (runtime) return runtime
  const wasmBinary = readWasm(join(grammarsDir, RUNTIME_FILE))
  if (!wasmBinary) return Promise.resolve(false)
  runtime = Parser.init({
    wasmBinary,
    print: (text: string) => process.stderr.write(`${text}\n`),
    printErr: (text: string) => process.stderr.write(`${text}\n`),
  } as unknown as Parameters<typeof Parser.init>[0])
    .then(() => true)
    .catch(() => {
      runtime = null
      return false
    })
  return runtime
}

function loadLanguage(grammarsDir: string, language: TreeLanguage): Promise<Language | null> {
  const cached = languages.get(language)
  if (cached) return cached
  const bytes = readWasm(join(grammarsDir, GRAMMAR_FILES[language]))
  if (!bytes) return Promise.resolve(null)
  const loading = Language.load(bytes).catch(() => {
    languages.delete(language)
    return null
  })
  languages.set(language, loading)
  return loading
}

export function resetTreeEngineForTests(): void {
  runtime = null
  languages.clear()
}

export async function scanTree(
  language: TreeLanguage,
  source: string,
  grammarsDir: string | null = locateGrammarsDir(),
): Promise<TreeScan> {
  if (!grammarsDir) return { ok: false, reason: 'engine_unavailable' }
  if (!(await initRuntime(grammarsDir))) return { ok: false, reason: 'engine_unavailable' }
  const lang = await loadLanguage(grammarsDir, language)
  if (!lang) return { ok: false, reason: 'engine_unavailable' }
  const parser = new Parser()
  try {
    parser.setLanguage(lang)
    const tree = parser.parse(source)
    if (!tree) return { ok: false, reason: 'engine_unavailable' }
    try {
      if (tree.rootNode.hasError) return { ok: false, reason: 'parse_error' }
      const comments: TreeComment[] = []
      const texts: TreeText[] = []
      const cursor = tree.walk()
      let descend = true
      for (;;) {
        const type = cursor.nodeType
        if (descend && type.includes('comment')) {
          comments.push({ start: cursor.startIndex, end: cursor.endIndex })
        } else if (descend && language === 'php' && type === 'text') {
          texts.push({ start: cursor.startIndex, end: cursor.endIndex })
        } else if (descend && cursor.gotoFirstChild()) {
          continue
        }
        if (cursor.gotoNextSibling()) {
          descend = true
          continue
        }
        if (!cursor.gotoParent()) break
        descend = false
      }
      cursor.delete()
      return { ok: true, comments, texts }
    } finally {
      tree.delete()
    }
  } finally {
    parser.delete()
  }
}
