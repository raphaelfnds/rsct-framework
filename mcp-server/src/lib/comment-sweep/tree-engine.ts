import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Language, Parser, type Node } from 'web-tree-sitter'

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

export type DeclarationKind = 'value' | 'type'

export interface TreeDeclaration {
  name: string
  kind: DeclarationKind
  exported: boolean
  defaultExport: boolean
  start: number
  end: number
}

export interface TreeImportName {
  imported: string
  local: string
}

export interface TreeImportEdge {
  specifier: string
  names: TreeImportName[]
  starReexport: boolean
}

export interface TreeMemberUse {
  object: string
  member: string
  owner: string | null
}

export interface TreeReference {
  name: string
  owner: string | null
}

export interface TreeSymbols {
  declarations: TreeDeclaration[]
  references: TreeReference[]
  imports: TreeImportEdge[]
  memberUses: TreeMemberUse[]
}

export type TreeSymbolScan =
  | { ok: true; symbols: TreeSymbols }
  | { ok: false; reason: 'parse_error' | 'engine_unavailable' }

export const NAMESPACE_IMPORT = '*'
export const DEFAULT_IMPORT = 'default'

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

const DECLARATION_KINDS: Readonly<Record<string, DeclarationKind>> = {
  function_declaration: 'value',
  generator_function_declaration: 'value',
  class_declaration: 'value',
  abstract_class_declaration: 'value',
  enum_declaration: 'value',
  type_alias_declaration: 'type',
  interface_declaration: 'type',
}

const VARIABLE_CONTAINERS = new Set(['lexical_declaration', 'variable_declaration'])
const REFERENCE_NODES = new Set(['identifier', 'type_identifier', 'shorthand_property_identifier'])
const SKIPPED_SUBTREES = new Set(['import_statement'])

function specifierOf(node: Node): string | null {
  const source = node.childForFieldName('source')
  if (!source) return null
  for (let i = 0; i < source.childCount; i++) {
    const child = source.child(i)
    if (child && child.type === 'string_fragment') return child.text
  }
  return null
}

function importNamesOf(node: Node): TreeImportName[] {
  const names: TreeImportName[] = []
  const stack: Node[] = [node]
  while (stack.length > 0) {
    const current = stack.pop()
    if (!current) continue
    if (current.type === 'import_specifier' || current.type === 'export_specifier') {
      const name = current.childForFieldName('name')
      const alias = current.childForFieldName('alias')
      if (name) names.push({ imported: name.text, local: alias ? alias.text : name.text })
      continue
    }
    if (current.type === 'namespace_import') {
      const binding = current.child(current.childCount - 1)
      if (binding) names.push({ imported: NAMESPACE_IMPORT, local: binding.text })
      continue
    }
    if (current.type === 'import_clause') {
      for (let i = 0; i < current.childCount; i++) {
        const child = current.child(i)
        if (!child) continue
        if (child.type === 'identifier') names.push({ imported: DEFAULT_IMPORT, local: child.text })
        else stack.push(child)
      }
      continue
    }
    for (let i = 0; i < current.childCount; i++) {
      const child = current.child(i)
      if (child) stack.push(child)
    }
  }
  return names
}

function declaredNamesOf(
  node: Node,
  kind: DeclarationKind,
  exported: boolean,
  defaultExport: boolean,
  range: { start: number; end: number },
): TreeDeclaration[] {
  if (VARIABLE_CONTAINERS.has(node.type)) {
    const found: TreeDeclaration[] = []
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)
      if (!child || child.type !== 'variable_declarator') continue
      const name = child.childForFieldName('name')
      if (name && name.type === 'identifier') {
        found.push({ name: name.text, kind: 'value', exported, defaultExport, start: range.start, end: range.end })
      }
    }
    return found
  }
  const name = node.childForFieldName('name')
  if (!name) return []
  return [{ name: name.text, kind, exported, defaultExport, start: range.start, end: range.end }]
}

function isDefaultExport(node: Node): boolean {
  for (let i = 0; i < node.childCount; i++) {
    if (node.child(i)?.type === 'default') return true
  }
  return false
}

function topLevelDeclarations(root: Node): { declarations: TreeDeclaration[]; nameSites: Set<number> } {
  const declarations: TreeDeclaration[] = []
  const nameSites = new Set<number>()
  const record = (
    node: Node,
    exported: boolean,
    defaultExport: boolean,
    range: { start: number; end: number },
  ): void => {
    const kind = DECLARATION_KINDS[node.type]
    if (kind === undefined && !VARIABLE_CONTAINERS.has(node.type)) return
    for (const declaration of declaredNamesOf(node, kind ?? 'value', exported, defaultExport, range)) {
      declarations.push(declaration)
    }
    if (VARIABLE_CONTAINERS.has(node.type)) {
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i)
        const name = child?.childForFieldName('name')
        if (name) nameSites.add(name.startIndex)
      }
      return
    }
    const name = node.childForFieldName('name')
    if (name) nameSites.add(name.startIndex)
  }
  for (let i = 0; i < root.childCount; i++) {
    const node = root.child(i)
    if (!node) continue
    if (node.type === 'export_statement') {
      const declaration = node.childForFieldName('declaration')
      if (declaration) {
        record(declaration, true, isDefaultExport(node), { start: node.startIndex, end: node.endIndex })
      }
      continue
    }
    record(node, false, false, { start: node.startIndex, end: node.endIndex })
  }
  return { declarations, nameSites }
}

function ownerAt(declarations: TreeDeclaration[], index: number): string | null {
  for (const declaration of declarations) {
    if (index >= declaration.start && index < declaration.end) return declaration.name
  }
  return null
}

function collectSymbols(root: Node): TreeSymbols {
  const { declarations, nameSites } = topLevelDeclarations(root)
  const references: TreeReference[] = []
  const imports: TreeImportEdge[] = []
  const memberUses: TreeMemberUse[] = []

  const visit = (node: Node): void => {
    const type = node.type
    if (type.includes('comment')) return
    if (type === 'import_statement' || type === 'export_statement') {
      const specifier = specifierOf(node)
      if (specifier !== null) {
        const names = importNamesOf(node)
        imports.push({ specifier, names, starReexport: type === 'export_statement' && names.length === 0 })
        return
      }
    }
    if (SKIPPED_SUBTREES.has(type)) return
    if (type === 'member_expression') {
      const object = node.childForFieldName('object')
      const property = node.childForFieldName('property')
      if (object && property && object.type === 'identifier') {
        memberUses.push({
          object: object.text,
          member: property.text,
          owner: ownerAt(declarations, node.startIndex),
        })
      }
    }
    if (REFERENCE_NODES.has(type) && !nameSites.has(node.startIndex)) {
      references.push({ name: node.text, owner: ownerAt(declarations, node.startIndex) })
    }
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)
      if (child) visit(child)
    }
  }
  visit(root)

  return { declarations, references, imports, memberUses }
}

export async function scanSymbols(
  language: TreeLanguage,
  source: string,
  grammarsDir: string | null = locateGrammarsDir(),
): Promise<TreeSymbolScan> {
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
      return { ok: true, symbols: collectSymbols(tree.rootNode) }
    } finally {
      tree.delete()
    }
  } finally {
    parser.delete()
  }
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
