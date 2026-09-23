import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Language, Parser, type Node, type TreeCursor } from 'web-tree-sitter'

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
  effect: boolean
  typeCheck: boolean
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
  dynamicPrefixes: string[]
  unboundDynamic: boolean
  directEval: boolean
  module: boolean
  dualMode: boolean
  hasJsx: boolean
}

export type TreeSymbolScan =
  | { ok: true; symbols: TreeSymbols }
  | { ok: false; reason: 'parse_error' | 'engine_unavailable' }

export const NAMESPACE_IMPORT = '*'
export const DEFAULT_IMPORT = 'default'
export const JSX_PRAGMA_OWNER = '@jsx'

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

export function ownerKeyOf(kind: DeclarationKind, name: string): string {
  return kind === 'type' ? `type ${name}` : name
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
const VALUE_REFERENCES = new Set(['identifier', 'shorthand_property_identifier'])
const BODY_SCOPES = new Set([
  'function_declaration',
  'generator_function_declaration',
  'function_expression',
  'function',
  'generator_function',
  'arrow_function',
  'method_definition',
])
const FUNCTION_SCOPES = new Set([
  ...BODY_SCOPES,
  'function_signature',
  'method_signature',
  'abstract_method_signature',
  'call_signature',
  'construct_signature',
  'function_type',
  'constructor_type',
])
const HOISTING_BOUNDARIES = new Set([...FUNCTION_SCOPES, 'class_static_block'])
const NAMED_FUNCTION_EXPRESSIONS = new Set(['function_expression', 'function', 'generator_function'])
const LOOP_DECLARATION_KEYWORDS = new Set(['const', 'let', 'var'])
const EFFECT_NODES = new Set([
  'call_expression',
  'new_expression',
  'await_expression',
  'assignment_expression',
  'augmented_assignment_expression',
  'update_expression',
  'yield_expression',
  'decorator',
  'class_static_block',
])
const CLASS_FIELDS = new Set(['public_field_definition', 'field_definition'])
const GLOB_METHODS = new Set(['glob', 'globEager'])
const GLOB_META = /[*?[{(!]/
const JSX_PRAGMA = /@jsx(?:Frag)?\s+([A-Za-z_$][\w$]*)/g
const COMMONJS_NAMES = new Set(['require', 'module', 'exports'])
const PLAIN_VALUES = new Set(['identifier', 'member_expression', 'string', 'number', 'true', 'false', 'null', 'undefined'])
const DUAL_MODE_GUARDS = new Set(['module', 'exports', 'define'])
const SKIP = -1

interface Scope {
  values: ReadonlySet<string>
  types: ReadonlySet<string>
}

const NO_NAMES: ReadonlySet<string> = new Set<string>()

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

function patternNames(root: Node | null, out: Set<string>): void {
  const stack: Node[] = root ? [root] : []
  while (stack.length > 0) {
    const node = stack.pop()
    if (!node) continue
    switch (node.type) {
      case 'identifier':
      case 'shorthand_property_identifier_pattern':
        out.add(node.text)
        break
      case 'required_parameter':
      case 'optional_parameter': {
        const pattern = node.childForFieldName('pattern')
        if (pattern) stack.push(pattern)
        break
      }
      case 'pair_pattern': {
        const value = node.childForFieldName('value')
        if (value) stack.push(value)
        break
      }
      case 'assignment_pattern':
      case 'object_assignment_pattern': {
        const left = node.childForFieldName('left')
        if (left) stack.push(left)
        break
      }
      case 'object_pattern':
      case 'array_pattern':
      case 'rest_pattern':
        for (const child of namedChildren(node)) stack.push(child)
        break
      default:
        break
    }
  }
}

function declaratorNames(declaration: Node, out: Set<string>): void {
  for (const declarator of namedChildren(declaration)) {
    if (declarator.type === 'variable_declarator') patternNames(declarator.childForFieldName('name'), out)
  }
}

function hoistedVarNames(root: Node | null): Set<string> {
  const names = new Set<string>()
  const stack: Node[] = root ? [root] : []
  while (stack.length > 0) {
    const node = stack.pop()
    if (!node) continue
    for (const child of namedChildren(node)) {
      if (HOISTING_BOUNDARIES.has(child.type)) continue
      if (child.type === 'variable_declaration') declaratorNames(child, names)
      stack.push(child)
    }
  }
  return names
}

function varScope(node: Node): Scope | null {
  const values = hoistedVarNames(node)
  return values.size > 0 ? { values, types: NO_NAMES } : null
}

function parameterScope(node: Node): Scope {
  const values = new Set<string>()
  for (const param of namedChildren(node.childForFieldName('parameters'))) patternNames(param, values)
  patternNames(node.childForFieldName('parameter'), values)
  if (NAMED_FUNCTION_EXPRESSIONS.has(node.type)) {
    const own = node.childForFieldName('name')
    if (own) values.add(own.text)
  }
  const types = new Set<string>()
  for (const param of namedChildren(childOfType(node, 'type_parameters'))) {
    const name = param.type === 'type_parameter' ? param.childForFieldName('name') : null
    if (name) types.add(name.text)
  }
  return { values, types }
}

function blockScope(node: Node): Scope | null {
  const values = new Set<string>()
  const types = new Set<string>()
  for (const child of namedChildren(node)) {
    const name = child.childForFieldName('name')?.text
    switch (child.type) {
      case 'lexical_declaration':
        declaratorNames(child, values)
        break
      case 'function_declaration':
      case 'generator_function_declaration':
        if (name) values.add(name)
        break
      case 'class_declaration':
      case 'abstract_class_declaration':
      case 'enum_declaration':
        if (name) {
          values.add(name)
          types.add(name)
        }
        break
      case 'type_alias_declaration':
      case 'interface_declaration':
        if (name) types.add(name)
        break
      default:
        break
    }
  }
  return values.size > 0 || types.size > 0 ? { values, types } : null
}

function loopScope(node: Node): Scope | null {
  const values = new Set<string>()
  if (node.type === 'for_statement') {
    const initializer = node.childForFieldName('initializer')
    if (initializer && VARIABLE_CONTAINERS.has(initializer.type)) declaratorNames(initializer, values)
  } else {
    let declares = false
    for (let i = 0; i < node.childCount; i++) {
      if (LOOP_DECLARATION_KEYWORDS.has(node.child(i)?.type ?? '')) declares = true
    }
    if (declares) patternNames(node.childForFieldName('left'), values)
  }
  return values.size > 0 ? { values, types: NO_NAMES } : null
}

function catchScope(node: Node): Scope | null {
  const values = new Set<string>()
  patternNames(node.childForFieldName('parameter'), values)
  return values.size > 0 ? { values, types: NO_NAMES } : null
}

function stringText(node: Node): string | null {
  if (node.type !== 'string') return null
  return namedChildren(node)
    .filter((child) => child.type === 'string_fragment')
    .map((child) => child.text)
    .join('')
}

function staticText(node: Node): string | null {
  if (node.type === 'string') return stringText(node)
  if (node.type !== 'template_string') return null
  const parts = namedChildren(node)
  if (parts.some((part) => part.type !== 'string_fragment')) return null
  return parts.map((part) => part.text).join('')
}

function leadingText(root: Node): string {
  let node: Node | null = root
  while (node && (node.type === 'parenthesized_expression' || (node.type === 'binary_expression' && node.childForFieldName('operator')?.type === '+'))) {
    node = node.type === 'parenthesized_expression' ? (namedChildren(node)[0] ?? null) : node.childForFieldName('left')
  }
  if (!node) return ''
  if (node.type === 'string') return stringText(node) ?? ''
  if (node.type !== 'template_string') return ''
  let text = ''
  for (const part of namedChildren(node)) {
    if (part.type !== 'string_fragment') break
    text += part.text
  }
  return text
}

function globPrefix(pattern: string): string {
  const meta = pattern.search(GLOB_META)
  const head = meta < 0 ? pattern : pattern.slice(0, meta)
  return head.slice(0, head.lastIndexOf('/') + 1)
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

function namespaceExportName(node: Node): string | null {
  const namespace = childOfType(node, 'namespace_export')
  const name = namedChildren(namespace)[0]
  return name ? name.text : null
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

function hasLoadTimeEffect(root: Node | null): boolean {
  const stack: Node[] = root ? [root] : []
  while (stack.length > 0) {
    const node = stack.pop()
    if (!node) continue
    const type = node.type
    if (EFFECT_NODES.has(type)) return true
    if (type === 'unary_expression' && node.childForFieldName('operator')?.type === 'delete') return true
    if (type === 'method_definition' || (CLASS_FIELDS.has(type) && childOfType(node, 'static') === null)) {
      for (const child of namedChildren(node)) {
        if (child.type === 'decorator') return true
        if (child.type === 'computed_property_name') stack.push(child)
      }
      continue
    }
    if (BODY_SCOPES.has(type)) continue
    for (const child of namedChildren(node)) stack.push(child)
  }
  return false
}

function isDefaultExport(node: Node): boolean {
  return childOfType(node, 'default') !== null
}

function topLevelDeclarations(root: Node): { declarations: TreeDeclaration[]; nameSites: Set<number>; esm: boolean } {
  const declarations: TreeDeclaration[] = []
  const nameSites = new Set<number>()
  let esm = false
  const record = (node: Node, statement: Node, exported: boolean, defaultExport: boolean, decorated: boolean): void => {
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
          effect: hasLoadTimeEffect(declarator.childForFieldName('value')),
          typeCheck:
            name.text.startsWith('_') &&
            declarator.childForFieldName('type') !== null &&
            PLAIN_VALUES.has(declarator.childForFieldName('value')?.type ?? ''),
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
    const runsAtLoad = node.type === 'class_declaration' || node.type === 'abstract_class_declaration' || node.type === 'enum_declaration'
    declarations.push({
      name: name.text,
      kind,
      exported,
      effect: decorated || (runsAtLoad && hasLoadTimeEffect(node)),
      typeCheck: false,
      exposures: exported ? [defaultExport ? DEFAULT_IMPORT : name.text] : [],
      start: statement.startIndex,
      end: statement.endIndex,
      ownerStart: node.startIndex,
      ownerEnd: node.endIndex,
    })
  }
  for (const node of namedChildren(root)) {
    if (node.type === 'import_statement') esm = true
    if (node.type === 'export_statement') {
      esm = true
      const declaration = node.childForFieldName('declaration')
      if (declaration) record(declaration, node, true, isDefaultExport(node), childOfType(node, 'decorator') !== null)
      continue
    }
    record(node, node, false, false, false)
  }
  return { declarations, nameSites, esm }
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
    else return ownerKeyOf(candidate.kind, candidate.name)
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
  const { declarations, nameSites, esm } = topLevelDeclarations(root)
  const owners = [...declarations].sort((a, b) => a.ownerStart - b.ownerStart)
  const references: TreeReference[] = []
  const imports: TreeImportEdge[] = []
  const memberUses: TreeMemberUse[] = []
  const localExports: LocalExport[] = []
  const dynamicPrefixes: string[] = []
  const pragmas = new Set<string>()
  const flags = { unboundDynamic: false, directEval: false, commonJs: false, hasJsx: false, dualMode: false }
  const scopes: Scope[] = []
  const shadowsValue = (name: string): boolean => scopes.some((scope) => scope.values.has(name))
  const shadowsType = (name: string): boolean => scopes.some((scope) => scope.types.has(name))

  const reference = (name: string, index: number): void => {
    if (COMMONJS_NAMES.has(name)) flags.commonJs = true
    references.push({ name, owner: ownerAt(owners, index) })
  }

  const memberUse = (object: Node | null, member: Node | null, index: number): void => {
    if (!object || !member || object.type !== 'identifier' || shadowsValue(object.text)) return
    if (COMMONJS_NAMES.has(object.text)) flags.commonJs = true
    memberUses.push({ object: object.text, member: member.text, owner: ownerAt(owners, index) })
  }

  const dynamicTarget = (argument: Node | null, followComputed: boolean): void => {
    if (!argument) return
    const literal = staticText(argument)
    if (literal !== null) {
      if (literal.length > 0) imports.push({ specifier: literal, kind: 'dynamic', names: [], starReexport: false, namespaceReexport: null })
      return
    }
    if (!followComputed) return
    const prefix = leadingText(argument)
    if (prefix.length > 0) dynamicPrefixes.push(prefix)
    else flags.unboundDynamic = true
  }

  const globTarget = (argument: Node | null): void => {
    const patterns = argument?.type === 'array' ? namedChildren(argument) : argument ? [argument] : []
    for (const pattern of patterns) {
      const text = staticText(pattern)
      if (text !== null && text.startsWith('!')) continue
      const prefix = text === null ? '' : globPrefix(text)
      if (prefix.length > 0) dynamicPrefixes.push(prefix)
      else flags.unboundDynamic = true
    }
  }

  const contextTarget = (argument: Node | null): void => {
    const text = argument ? staticText(argument) : null
    if (text === null || text.length === 0) flags.unboundDynamic = true
    else dynamicPrefixes.push(text.endsWith('/') ? text : `${text}/`)
  }

  const recordCall = (node: Node): void => {
    const fn = node.childForFieldName('function')
    if (!fn) return
    const args = node.childForFieldName('arguments')
    const argument = args?.type === 'arguments' ? (namedChildren(args).find((child) => child.type !== 'comment') ?? null) : null
    const requireInScope = !shadowsValue('require')
    if (fn.type === 'identifier' && fn.text === 'eval' && !shadowsValue('eval')) flags.directEval = true
    if (fn.type === 'import' || (fn.type === 'identifier' && fn.text === 'require')) {
      dynamicTarget(argument, fn.type === 'import' || requireInScope)
      return
    }
    if (fn.type !== 'member_expression') return
    const object = fn.childForFieldName('object')
    const property = fn.childForFieldName('property')?.text ?? ''
    if (object?.type === 'meta_property' && object.text === 'import.meta' && GLOB_METHODS.has(property)) globTarget(argument)
    else if (object?.type === 'identifier' && object.text === 'require' && property === 'context' && requireInScope) contextTarget(argument)
  }

  const recordTypeofGuard = (node: Node): void => {
    if (node.childForFieldName('operator')?.type !== 'typeof') return
    const argument = node.childForFieldName('argument')
    if (argument?.type === 'identifier' && DUAL_MODE_GUARDS.has(argument.text) && !shadowsValue(argument.text)) flags.dualMode = true
  }

  const recordImport = (node: Node): void => {
    const specifier = specifierOf(node)
    if (specifier !== null) {
      imports.push({ specifier, kind: 'import', names: importNamesOf(node), starReexport: false, namespaceReexport: null })
      return
    }
    const clause = childOfType(node, 'import_require_clause')
    const binding = clause ? namedChildren(clause).find((child) => child.type === 'identifier') : undefined
    const source = clause?.childForFieldName('source')
    const required = source ? stringText(source) : null
    if (binding && required) {
      imports.push({
        specifier: required,
        kind: 'import',
        names: [{ imported: NAMESPACE_IMPORT, local: binding.text }],
        starReexport: false,
        namespaceReexport: null,
      })
    }
  }

  const recordExport = (node: Node): boolean => {
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
      return true
    }
    const value = node.childForFieldName('value')
    if (value?.type === 'identifier' && node.childForFieldName('declaration') === null) {
      localExports.push({ local: value.text, exposed: DEFAULT_IMPORT })
      return true
    }
    const clause = childOfType(node, 'export_clause')
    if (!clause) return false
    for (const entry of namedChildren(clause)) {
      if (entry.type !== 'export_specifier') continue
      const name = entry.childForFieldName('name')
      const alias = entry.childForFieldName('alias')
      if (name) localExports.push({ local: name.text, exposed: (alias ?? name).text })
    }
    return true
  }

  const enter = (cursor: TreeCursor, parentType: string | undefined): number => {
    const type = cursor.nodeType
    if (type === 'comment') {
      const text = cursor.nodeText
      if (text.includes('@jsx')) for (const match of text.matchAll(JSX_PRAGMA)) if (match[1]) pragmas.add(match[1])
      return SKIP
    }
    if (type.startsWith('jsx_')) flags.hasJsx = true
    let current: Node | null = null
    const node = (): Node => (current ??= cursor.currentNode)
    if (type === 'import_statement') {
      recordImport(node())
      return SKIP
    }
    if (type === 'export_statement' && recordExport(node())) return SKIP
    if (type === 'call_expression') recordCall(node())
    else if (type === 'unary_expression') recordTypeofGuard(node())
    else if (type === 'member_expression') memberUse(node().childForFieldName('object'), node().childForFieldName('property'), cursor.startIndex)
    else if (type === 'nested_type_identifier') memberUse(node().childForFieldName('module'), node().childForFieldName('name'), cursor.startIndex)

    const field = cursor.currentFieldName
    if (VALUE_REFERENCES.has(type)) {
      if ((parentType === 'member_expression' && field === 'object') || parentType === 'nested_type_identifier') return 0
      const start = cursor.startIndex
      const name = cursor.nodeText
      if (!nameSites.has(start) && !shadowsValue(name)) reference(name, start)
      return 0
    }
    if (type === 'type_identifier') {
      if (parentType === 'nested_type_identifier') return 0
      const start = cursor.startIndex
      const name = cursor.nodeText
      if (!nameSites.has(start) && !shadowsType(name)) reference(name, start)
      return 0
    }

    let pushed = 0
    const push = (scope: Scope | null): void => {
      if (!scope) return
      scopes.push(scope)
      pushed++
    }
    if (field === 'body' && parentType !== undefined && BODY_SCOPES.has(parentType)) push(varScope(node()))
    if (FUNCTION_SCOPES.has(type)) push(parameterScope(node()))
    else if (type === 'statement_block') push(blockScope(node()))
    else if (type === 'class_static_block') push(varScope(node()))
    else if (type === 'catch_clause') push(catchScope(node()))
    else if (type === 'for_statement' || type === 'for_in_statement') push(loopScope(node()))
    return pushed
  }

  const cursor = root.walk()
  const path: string[] = []
  const pushedAt: number[] = []
  try {
    let descend = true
    for (;;) {
      if (descend) {
        const type = cursor.nodeType
        const pushed = enter(cursor, path[path.length - 1])
        if (pushed !== SKIP && cursor.gotoFirstChild()) {
          path.push(type)
          pushedAt.push(pushed)
          continue
        }
        if (pushed > 0) scopes.length -= pushed
      }
      if (cursor.gotoNextSibling()) {
        descend = true
        continue
      }
      if (!cursor.gotoParent()) break
      path.pop()
      const pushed = pushedAt.pop() ?? 0
      if (pushed > 0) scopes.length -= pushed
      descend = false
    }
  } finally {
    cursor.delete()
  }

  applyLocalExports(declarations, localExports, imports, references)
  if (flags.hasJsx) for (const name of pragmas) references.push({ name, owner: JSX_PRAGMA_OWNER })

  return {
    declarations,
    references,
    imports,
    memberUses,
    dynamicPrefixes,
    unboundDynamic: flags.unboundDynamic,
    directEval: flags.directEval,
    module: esm || flags.commonJs,
    dualMode: flags.dualMode && !esm,
    hasJsx: flags.hasJsx,
  }
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
