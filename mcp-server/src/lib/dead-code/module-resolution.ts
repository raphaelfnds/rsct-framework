import { builtinModules } from 'node:module'
import { dirname, isAbsolute, normalize, relative, resolve as resolvePath } from 'node:path'

import { toPosix } from '../phase-scope.js'
import { resolveImportCandidates, type ResolveProbe } from '../reverse-dep-walk.js'

export type Resolution =
  | { kind: 'files'; files: string[]; query: boolean }
  | { kind: 'external' }
  | { kind: 'missing' }
  | { kind: 'unknown'; within: string | null }

export interface ModuleResolver {
  resolve(fromRel: string, specifier: string): Resolution
  prefixFiles(fromRel: string, prefix: string): string[] | null
  jsxFactories(fromRel: string): string[]
}

interface PathMapping {
  pattern: string
  targets: string[]
}

interface CompilerSettings {
  baseUrl: string | null
  paths: PathMapping[] | null
  pathsDir: string
  jsx: string | null
  jsxFactories: string[]
}

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
const CODE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.mts',
  '.cts',
  '.vue',
  '.svelte',
  '.astro',
  '.html',
  '.htm',
  '.mdx',
])
const CONFIG_NAMES = ['tsconfig.json', 'jsconfig.json']
const MAX_EXTENDS_DEPTH = 16
const BUILTINS: ReadonlySet<string> = new Set(builtinModules)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function skipInsignificant(text: string, from: number): number {
  let i = from
  while (i < text.length) {
    const ch = text[i]
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end < 0 ? text.length : end + 2
    } else {
      break
    }
  }
  return i
}

export function parseJsonc(source: string): unknown {
  const text = source.startsWith('﻿') ? source.slice(1) : source
  let out = ''
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      out += text.slice(i, j + 1)
      i = j + 1
      continue
    }
    if (ch === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) {
      i = skipInsignificant(text, i)
      continue
    }
    if (ch === ',') {
      const next = text[skipInsignificant(text, i + 1)]
      if (next === '}' || next === ']') {
        i++
        continue
      }
    }
    out += ch
    i++
  }
  try {
    return JSON.parse(out) as unknown
  } catch {
    return null
  }
}

function packageNameOf(specifier: string): string {
  const segments = specifier.split('/')
  return specifier.startsWith('@') ? segments.slice(0, 2).join('/') : (segments[0] ?? specifier)
}

function isBuiltin(specifier: string): boolean {
  return specifier.startsWith('node:') || BUILTINS.has(specifier) || BUILTINS.has(packageNameOf(specifier))
}

function isAsset(path: string): boolean {
  if (!path.startsWith('.') && !path.startsWith('/') && packageNameOf(path) === path) return false
  const segment = path.slice(path.lastIndexOf('/') + 1)
  const dot = segment.lastIndexOf('.')
  return dot > 0 && !CODE_EXTENSIONS.has(segment.slice(dot).toLowerCase())
}

function splitQuery(specifier: string): { path: string; query: boolean } {
  const cut = specifier.search(/[?#]/)
  if (cut <= 0) return { path: specifier, query: false }
  return { path: specifier.slice(0, cut), query: true }
}

function rootName(expression: unknown): string | null {
  if (typeof expression !== 'string') return null
  const root = expression.split('.')[0]?.trim()
  return root && /^[A-Za-z_$][\w$]*$/.test(root) ? root : null
}

function matchPattern(pattern: string, specifier: string): string | null {
  const star = pattern.indexOf('*')
  if (star < 0) return pattern === specifier ? '' : null
  const prefix = pattern.slice(0, star)
  const suffix = pattern.slice(star + 1)
  if (specifier.length < prefix.length + suffix.length) return null
  if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) return null
  return specifier.slice(prefix.length, specifier.length - suffix.length)
}

function prefixLength(pattern: string): number {
  const star = pattern.indexOf('*')
  return star < 0 ? pattern.length : star
}

export function corpusProbe(projectRoot: string, corpus: readonly string[]): ResolveProbe {
  const files = new Set<string>()
  const directories = new Set<string>()
  for (const path of corpus) {
    files.add(resolvePath(projectRoot, path))
    let slash = path.lastIndexOf('/')
    while (slash > 0) {
      directories.add(resolvePath(projectRoot, path.slice(0, slash)))
      slash = path.lastIndexOf('/', slash - 1)
    }
  }
  return {
    exists: (abs) => files.has(normalize(abs)) || directories.has(normalize(abs)),
    isFile: (abs) => files.has(normalize(abs)),
    isDirectory: (abs) => directories.has(normalize(abs)),
    hasExactPath: (abs) => files.has(normalize(abs)),
  }
}

export function createModuleResolver(args: {
  projectRoot: string
  corpus: readonly string[]
  configs: readonly string[]
  readText: (rel: string) => string | null
}): ModuleResolver {
  const { projectRoot, corpus } = args
  const probe = corpusProbe(projectRoot, corpus)
  const entries = new Map<string, Set<string>>()
  const configSet = new Set(args.configs)
  const parsed = new Map<string, unknown>()
  const settingsByConfig = new Map<string, CompilerSettings | null>()
  const settingsByDir = new Map<string, CompilerSettings | null>()

  const relOf = (abs: string): string => toPosix(relative(projectRoot, abs))
  const insideRepo = (rel: string): boolean => !rel.startsWith('..') && !isAbsolute(rel)

  const json = (rel: string): unknown => {
    if (parsed.has(rel)) return parsed.get(rel)
    const text = args.readText(rel)
    const value = text === null ? null : parseJsonc(text)
    parsed.set(rel, value)
    return value
  }

  const workspaces = new Map<string, string>()
  const declared = new Set<string>()
  for (const rel of args.configs) {
    if (rel !== 'package.json' && !rel.endsWith('/package.json')) continue
    const manifest = json(rel)
    if (!isRecord(manifest)) continue
    if (typeof manifest.name === 'string' && manifest.name.length > 0) {
      workspaces.set(manifest.name, rel.slice(0, rel.length - 'package.json'.length))
    }
    for (const field of DEPENDENCY_FIELDS) {
      const deps = manifest[field]
      if (isRecord(deps)) for (const name of Object.keys(deps)) declared.add(name)
    }
  }

  const extendsTarget = (fromRel: string, target: string): string | null => {
    if (!target.startsWith('.') && !isAbsolute(target)) return null
    const abs = resolvePath(projectRoot, dirname(fromRel), target)
    for (const candidate of [abs, `${abs}.json`, resolvePath(abs, 'tsconfig.json')]) {
      const rel = relOf(candidate)
      if (insideRepo(rel) && json(rel) !== null) return rel
    }
    return null
  }

  const settingsOf = (rel: string, depth: number): CompilerSettings | null => {
    if (settingsByConfig.has(rel)) return settingsByConfig.get(rel) ?? null
    if (depth > MAX_EXTENDS_DEPTH) return null
    settingsByConfig.set(rel, null)
    const config = json(rel)
    if (!isRecord(config)) return null
    const dirAbs = resolvePath(projectRoot, dirname(rel))
    let settings: CompilerSettings = { baseUrl: null, paths: null, pathsDir: dirAbs, jsx: null, jsxFactories: [] }
    const parents = typeof config.extends === 'string' ? [config.extends] : Array.isArray(config.extends) ? config.extends : []
    for (const parent of parents) {
      const parentRel = typeof parent === 'string' ? extendsTarget(rel, parent) : null
      const inherited = parentRel ? settingsOf(parentRel, depth + 1) : null
      if (!inherited) continue
      settings = {
        baseUrl: inherited.baseUrl ?? settings.baseUrl,
        paths: inherited.paths ?? settings.paths,
        pathsDir: inherited.paths ? inherited.pathsDir : settings.pathsDir,
        jsx: inherited.jsx ?? settings.jsx,
        jsxFactories: inherited.jsxFactories.length > 0 ? inherited.jsxFactories : settings.jsxFactories,
      }
    }
    const options = config.compilerOptions
    if (isRecord(options)) {
      if (typeof options.baseUrl === 'string') settings.baseUrl = resolvePath(dirAbs, options.baseUrl)
      if (isRecord(options.paths)) {
        settings.paths = Object.entries(options.paths).map(([pattern, targets]) => ({
          pattern,
          targets: Array.isArray(targets) ? targets.filter((t): t is string => typeof t === 'string') : [],
        }))
        settings.pathsDir = dirAbs
      }
      if (typeof options.jsx === 'string') settings.jsx = options.jsx
      const factories = [rootName(options.jsxFactory), rootName(options.jsxFragmentFactory)].filter((n): n is string => n !== null)
      if (factories.length > 0) settings.jsxFactories = factories
    }
    if (settings.paths === null && Array.isArray(config.references)) {
      for (const reference of config.references) {
        const target = isRecord(reference) && typeof reference.path === 'string' ? extendsTarget(rel, reference.path) : null
        const referenced = target ? settingsOf(target, depth + 1) : null
        if (referenced?.paths) {
          settings = { ...settings, baseUrl: settings.baseUrl ?? referenced.baseUrl, paths: referenced.paths, pathsDir: referenced.pathsDir }
          break
        }
      }
    }
    settingsByConfig.set(rel, settings)
    return settings
  }

  const settingsFor = (fromRel: string): CompilerSettings | null => {
    let dir = dirname(fromRel) === '.' ? '' : toPosix(dirname(fromRel))
    const visited: string[] = []
    let found: CompilerSettings | null = null
    for (;;) {
      if (settingsByDir.has(dir)) {
        found = settingsByDir.get(dir) ?? null
        break
      }
      visited.push(dir)
      const config = CONFIG_NAMES.map((name) => (dir ? `${dir}/${name}` : name)).find((rel) => configSet.has(rel))
      if (config) {
        found = settingsOf(config, 0)
        break
      }
      if (dir === '') break
      const slash = dir.lastIndexOf('/')
      dir = slash < 0 ? '' : dir.slice(0, slash)
    }
    for (const seen of visited) settingsByDir.set(seen, found)
    return found
  }

  const filesAt = (fromRel: string, abs: string): string[] =>
    resolveImportCandidates(projectRoot, resolvePath(projectRoot, fromRel), abs, entries, probe).map(relOf)

  const mapped = (settings: CompilerSettings, specifier: string): string[] | null => {
    if (!settings.paths) return null
    let best: PathMapping | null = null
    let bestMatch = ''
    for (const mapping of settings.paths) {
      const match = matchPattern(mapping.pattern, specifier)
      if (match === null) continue
      if (!best || prefixLength(mapping.pattern) > prefixLength(best.pattern)) {
        best = mapping
        bestMatch = match
      }
    }
    if (!best) return null
    const base = settings.baseUrl ?? settings.pathsDir
    return best.targets.map((target) => resolvePath(base, target.replace('*', bestMatch)))
  }

  const resolve = (fromRel: string, specifier: string): Resolution => {
    const { path, query } = splitQuery(specifier)
    if (isAsset(path)) return { kind: 'missing' }
    if (path.startsWith('.')) {
      const files = filesAt(fromRel, path)
      return files.length > 0 ? { kind: 'files', files, query } : { kind: 'missing' }
    }
    if (path.startsWith('/')) {
      const files = filesAt(fromRel, resolvePath(projectRoot, `.${path}`))
      return files.length > 0 ? { kind: 'files', files, query } : { kind: 'unknown', within: null }
    }
    if (isBuiltin(path)) return { kind: 'external' }
    const settings = settingsFor(fromRel)
    if (settings) {
      for (const abs of mapped(settings, path) ?? []) {
        const files = filesAt(fromRel, abs)
        if (files.length > 0) return { kind: 'files', files, query }
      }
      if (settings.baseUrl) {
        const files = filesAt(fromRel, resolvePath(settings.baseUrl, path))
        if (files.length > 0) return { kind: 'files', files, query }
      }
    }
    const name = packageNameOf(path)
    const workspace = workspaces.get(name)
    if (workspace !== undefined) return { kind: 'unknown', within: workspace }
    if (declared.has(name)) return { kind: 'external' }
    return { kind: 'unknown', within: null }
  }

  const underPrefix = (abs: string): string[] | null => {
    const rel = relOf(abs)
    if (!insideRepo(rel)) return []
    return corpus.filter((path) => rel === '' || path.startsWith(rel))
  }

  const prefixFiles = (fromRel: string, prefix: string): string[] | null => {
    if (prefix.startsWith('.')) return underPrefix(resolvePath(projectRoot, dirname(fromRel), prefix))
    if (prefix.startsWith('/')) return underPrefix(resolvePath(projectRoot, `.${prefix}`))
    const settings = settingsFor(fromRel)
    if (settings?.paths) {
      const files: string[] = []
      let matched = false
      for (const mapping of settings.paths) {
        const head = mapping.pattern.slice(0, prefixLength(mapping.pattern))
        if (!mapping.pattern.includes('*') || !prefix.startsWith(head)) continue
        matched = true
        const rest = prefix.slice(head.length)
        const base = settings.baseUrl ?? settings.pathsDir
        for (const target of mapping.targets) {
          const star = target.indexOf('*')
          files.push(...(underPrefix(resolvePath(base, (star < 0 ? target : target.slice(0, star)) + rest)) ?? []))
        }
      }
      if (matched) return [...new Set(files)]
    }
    if (settings?.baseUrl) {
      const files = underPrefix(resolvePath(settings.baseUrl, prefix)) ?? []
      if (files.length > 0) return files
    }
    const name = packageNameOf(prefix)
    const workspace = workspaces.get(name)
    if (workspace !== undefined) return corpus.filter((path) => path.startsWith(workspace))
    if (isBuiltin(prefix) || declared.has(name)) return []
    return null
  }

  const jsxFactories = (fromRel: string): string[] => {
    const settings = settingsFor(fromRel)
    if (!settings) return []
    if (settings.jsxFactories.length > 0) return settings.jsxFactories
    return settings.jsx === 'react' ? ['React'] : []
  }

  return { resolve, prefixFiles, jsxFactories }
}
