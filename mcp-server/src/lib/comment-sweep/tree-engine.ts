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
  exposures: string[]
  start: number
  end: number
  ownerStart: number
  ownerEnd: number
}

export interface TreeImportName {
  imported: string
  local: string
}

export type TreeEdgeKind = 'import' | 'reexport' | 'dynamic'

export interface TreeImportEdge {
  specifier: string
  kind: TreeEdgeKind
  names: TreeImportName[]
  starReexport: boolean
  namespaceReexport: string | null
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
  function_signature: 'value',
  class_declaration: 'value',
  abstract_class_declaration: 'value',
  enum_declaration: 'value',
  type_alias_declaration: 'type',
  interface_declaration: 'type',
}

const VARIABLE_CONTAINERS = new Set(['lexical_declaration', 'variable_declaration'])
const REFERENCE_NODES = new Set(['identifier', 'type_identifier', 'shorthand_property_identifier'])
const FUNCTION_SCOPES = new Set([
  'function_declaration',
  'generator_function_declaration',
  'function_expression',
  'function',
  'generator_function',
  'arrow_function',
  'method_definition',
])
const NAMED_FUNCTION_EXPRESSIONS = new Set(['function_expression', 'function', 'generator_function'])
const BLOCK_DECLARATIONS = new Set([
  'function_declaration',
  'generator_function_declaration',
  'class_declaration',
  'abstract_class_declaration',
])
const LOOP_DECLARATION_KEYWORDS = new Set(['const', 'let', 'var'])

function namedChildren(node: Node | null): Node[] {
  const out: Node[] = []
  if (!node) return out
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (child?.isNamed) out.push(child)
  }
  return out
}

function childOfType(node: Node, type: string): Node | null {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (child?.type === type) return child
  }
  return null
}

function patternNames(node: Node | null, out: Set<string>): void {
  if (!node) return
  switch (node.type) {
    case 'identifier':
    case 'shorthand_property_identifier_pattern':
      out.add(node.text)
      return
    case 'required_parameter':
    case 'optional_parameter':
      patternNames(node.childForFieldName('pattern'), out)
      return
    case 'pair_pattern':
      patternNames(node.childForFieldName('value'), out)
      return
    case 'assignment_pattern':
    case 'object_assignment_pattern':
      patternNames(node.childForFieldName('left'), out)
      return
    case 'object_pattern':
    case 'array_pattern':
    case 'rest_pattern':
      for (const child of namedChildren(node)) patternNames(child, out)
      return
    default:
      return
  }
}

function declaratorNames(declaration: Node, out: Set<string>): void {
  for (const declarator of namedChildren(declaration)) {
    if (declarator.type === 'variable_declarator') patternNames(declarator.childForFieldName('name'), out)
  }
}

function typeParameterNames(node: Node, out: Set<string>): void {
  const params = childOfType(node, 'type_parameters')
  for (const param of namedChildren(params)) {
    const name = param.type === 'type_parameter' ? param.childForFieldName('name') : null
    if (name) out.add(name.text)
  }
}

function hoistedVarNames(node: Node | null, out: Set<string>): void {
  for (const child of namedChildren(node)) {
    if (FUNCTION_SCOPES.has(child.type)) continue
    if (child.type === 'variable_declaration') declaratorNames(child, out)
    hoistedVarNames(child, out)
  }
}

function functionBindings(node: Node): Set<string> {
  const names = new Set<string>()
  for (const param of namedChildren(node.childForFieldName('parameters'))) patternNames(param, names)
  patternNames(node.childForFieldName('parameter'), names)
  if (NAMED_FUNCTION_EXPRESSIONS.has(node.type)) {
    const own = node.childForFieldName('name')
    if (own) names.add(own.text)
  }
  typeParameterNames(node, names)
  hoistedVarNames(node.childForFieldName('body'), names)
  return names
}

function blockBindings(node: Node): Set<string> {
  const names = new Set<string>()
  for (const child of namedChildren(node)) {
    if (child.type === 'lexical_declaration') {
      declaratorNames(child, names)
    } else if (BLOCK_DECLARATIONS.has(child.type)) {
      const name = child.childForFieldName('name')
      if (name) names.add(name.text)
    }
  }
  return names
}

function loopBindings(node: Node): Set<string> | null {
  if (node.type === 'for_statement') {
    const initializer = node.childForFieldName('initializer')
    if (!initializer || !VARIABLE_CONTAINERS.has(initializer.type)) return null
    const names = new Set<string>()
    declaratorNames(initializer, names)
    return names
  }
  if (node.type === 'for_in_statement') {
    let declares = false
    for (let i = 0; i < node.childCount; i++) {
      if (LOOP_DECLARATION_KEYWORDS.has(node.child(i)?.type ?? '')) declares = true
    }
    if (!declares) return null
    const names = new Set<string>()
    patternNames(node.childForFieldName('left'), names)
    return names
  }
  return null
}

function catchBindings(node: Node): Set<string> {
  const names = new Set<string>()
  patternNames(node.childForFieldName('parameter'), names)
  return names
}

function stringArgument(call: Node): string | null {
  const first = namedChildren(call.childForFieldName('arguments'))[0]
  if (!first || first.type !== 'string') return null
  return childOfType(first, 'string_fragment')?.text ?? null
}

function namespaceExportName(node: Node): string | null {
  const namespace = childOfType(node, 'namespace_export')
  const name = namedChildren(namespace)[0]
  return name ? name.text : null
}

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

function isDefaultExport(node: Node): boolean {
  return childOfType(node, 'default') !== null
}

function topLevelDeclarations(root: Node): { declarations: TreeDeclaration[]; nameSites: Set<number> } {
  const declarations: TreeDeclaration[] = []
  const nameSites = new Set<number>()
  const record = (node: Node, statement: Node, exported: boolean, defaultExport: boolean): void => {
    if (VARIABLE_CONTAINERS.has(node.type)) {
      for (const declarator of namedChildren(node)) {
        if (declarator.type !== 'variable_declarator') continue
        const name = declarator.childForFieldName('name')
        if (!name || name.type !== 'identifier') continue
        nameSites.add(name.startIndex)
        declarations.push({
          name: name.text,
          kind: 'value',
          exported,
          defaultExport: false,
          exposures: exported ? [name.text] : [],
          start: statement.startIndex,
          end: statement.endIndex,
          ownerStart: declarator.startIndex,
          ownerEnd: declarator.endIndex,
        })
      }
      return
    }
    const kind = DECLARATION_KINDS[node.type]
    if (kind === undefined) return
    const name = node.childForFieldName('name')
    if (!name) return
    nameSites.add(name.startIndex)
    declarations.push({
      name: name.text,
      kind,
      exported,
      defaultExport,
      exposures: exported ? [defaultExport ? DEFAULT_IMPORT : name.text] : [],
      start: statement.startIndex,
      end: statement.endIndex,
      ownerStart: node.startIndex,
      ownerEnd: node.endIndex,
    })
  }
  for (const node of namedChildren(root)) {
    if (node.type === 'export_statement') {
      const declaration = node.childForFieldName('declaration')
      if (declaration) record(declaration, node, true, isDefaultExport(node))
      continue
    }
    record(node, node, false, false)
  }
  return { declarations, nameSites }
}

function ownerAt(owners: readonly TreeDeclaration[], index: number): string | null {
  let low = 0
  let high = owners.length - 1
  while (low <= high) {
    const mid = (low + high) >> 1
    const candidate = owners[mid]
    if (!candidate) return null
    if (index < candidate.ownerStart) high = mid - 1
    else if (index >= candidate.ownerEnd) low = mid + 1
    else return candidate.name
  }
  return null
}

interface LocalExport {
  local: string
  exposed: string
}

function applyLocalExports(
  declarations: TreeDeclaration[],
  localExports: readonly LocalExport[],
  imports: TreeImportEdge[],
  references: TreeReference[],
): void {
  const importBindings = new Map<string, { specifier: string; imported: string }>()
  for (const edge of imports) {
    if (edge.kind !== 'import') continue
    for (const name of edge.names) importBindings.set(name.local, { specifier: edge.specifier, imported: name.imported })
  }
  for (const entry of localExports) {
    const owned = declarations.filter((declaration) => declaration.name === entry.local)
    if (owned.length > 0) {
      for (const declaration of owned) {
        declaration.exported = true
        if (!declaration.exposures.includes(entry.exposed)) declaration.exposures.push(entry.exposed)
        if (entry.exposed === DEFAULT_IMPORT) declaration.defaultExport = true
      }
      continue
    }
    const imported = importBindings.get(entry.local)
    if (imported) {
      imports.push({
        specifier: imported.specifier,
        kind: 'reexport',
        names: [{ imported: imported.imported, local: entry.exposed }],
        starReexport: false,
        namespaceReexport: null,
      })
      continue
    }
    references.push({ name: entry.local, owner: null })
  }
}

function collectSymbols(root: Node): TreeSymbols {
  const { declarations, nameSites } = topLevelDeclarations(root)
  const owners = [...declarations].sort((a, b) => a.ownerStart - b.ownerStart)
  const references: TreeReference[] = []
  const imports: TreeImportEdge[] = []
  const memberUses: TreeMemberUse[] = []
  const localExports: LocalExport[] = []
  const scopes: Set<string>[] = []
  const shadowed = (name: string): boolean => scopes.some((scope) => scope.has(name))

  const visitChildren = (node: Node): void => {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)
      if (child) visit(child)
    }
  }

  const visitScoped = (names: Set<string>, node: Node): void => {
    scopes.push(names)
    try {
      visitChildren(node)
    } finally {
      scopes.pop()
    }
  }

  const visitExport = (node: Node): void => {
    const specifier = specifierOf(node)
    if (specifier !== null) {
      const namespaceReexport = namespaceExportName(node)
      const names = importNamesOf(node)
      imports.push({
        specifier,
        kind: 'reexport',
        names,
        starReexport: names.length === 0 && namespaceReexport === null,
        namespaceReexport,
      })
      return
    }
    const value = node.childForFieldName('value')
    if (value?.type === 'identifier' && node.childForFieldName('declaration') === null) {
      localExports.push({ local: value.text, exposed: DEFAULT_IMPORT })
      return
    }
    const clause = childOfType(node, 'export_clause')
    if (clause) {
      for (const entry of namedChildren(clause)) {
        if (entry.type !== 'export_specifier') continue
        const name = entry.childForFieldName('name')
        const alias = entry.childForFieldName('alias')
        if (name) localExports.push({ local: name.text, exposed: (alias ?? name).text })
      }
      return
    }
    visitChildren(node)
  }

  const recordDynamicEdge = (node: Node): void => {
    const fn = node.childForFieldName('function')
    if (!fn) return
    const isImport = fn.type === 'import'
    const isRequire = fn.type === 'identifier' && fn.text === 'require' && !shadowed('require')
    if (!isImport && !isRequire) return
    const specifier = stringArgument(node)
    if (specifier === null) return
    imports.push({ specifier, kind: 'dynamic', names: [], starReexport: false, namespaceReexport: null })
  }

  const visit = (node: Node): void => {
    const type = node.type
    if (type === 'import_statement') {
      const specifier = specifierOf(node)
      if (specifier !== null) {
        imports.push({ specifier, kind: 'import', names: importNamesOf(node), starReexport: false, namespaceReexport: null })
      }
      return
    }
    if (type === 'export_statement') {
      visitExport(node)
      return
    }
    if (type === 'call_expression') recordDynamicEdge(node)
    if (FUNCTION_SCOPES.has(type)) {
      visitScoped(functionBindings(node), node)
      return
    }
    if (type === 'statement_block') {
      visitScoped(blockBindings(node), node)
      return
    }
    if (type === 'catch_clause') {
      visitScoped(catchBindings(node), node)
      return
    }
    const loop = loopBindings(node)
    if (loop) {
      visitScoped(loop, node)
      return
    }
    if (type === 'member_expression') {
      const object = node.childForFieldName('object')
      const property = node.childForFieldName('property')
      if (object && property && object.type === 'identifier' && !shadowed(object.text)) {
        memberUses.push({ object: object.text, member: property.text, owner: ownerAt(owners, node.startIndex) })
      }
    }
    if (REFERENCE_NODES.has(type) && !nameSites.has(node.startIndex) && !shadowed(node.text)) {
      references.push({ name: node.text, owner: ownerAt(owners, node.startIndex) })
    }
    visitChildren(node)
  }
  visit(root)
  applyLocalExports(declarations, localExports, imports, references)

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
