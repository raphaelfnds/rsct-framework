import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { decideAuditPath, type AuditEntry } from './audit-log.js'
import { affectedConsumers, contractsTouchingPaths, parseContracts, readContracts, type Contract, type ContractGraph } from './contracts.js'
import { specLabel } from './dialog-text.js'
import type { GitExecutor } from './git.js'
import type { RsctAuditConfig, RsctConfig } from './project-root.js'
import { canonicalPath } from './repo-anchor.js'
import { isUniverseDir, resolveUniverseRoot } from './universe.js'

export const UNIVERSE_BASELINE_EVENT = 'universe.baseline'

type Source = 'working tree' | 'HEAD' | 'upstream'

interface ConfigFacts {
  where: string
  dir: string
  mode: string | null
  app: string | null
  org: string | null
  universeName: string | null
  universeLocal: string | null
}

interface RootFacts {
  path: string
  branch: string | null
  head: string | null
  upstreamRef: string | null
  upstream: string | null
  notes: string[]
  graphs: Array<{ source: Source; graph: ContractGraph }>
}

interface RootRecord {
  path: string
  branch: string | null
  head: string | null
  upstream_ref: string | null
  upstream: string | null
  contracts: Record<string, string>
}

interface ScopeRecord {
  mode: boolean
  apps: string[]
  roots: RootRecord[]
}

export interface ContractFacts {
  multiRepo: boolean
  recordBaseline: boolean
  apps: string[]
  note: string | null
  ids: string[]
  consumers: string[]
  hits: Contract[]
  contracts: Contract[]
  universeLinked: boolean
  inactive: boolean
  lines: string[]
  changes: string[]
  record: Array<{ root: string; head: string | null; upstream: string | null }>
  baseline: AuditEntry
}

const PIECE = 120
const ID_SHOWN = 12
const IDS_SHOWN = 400

function shortPath(path: string): string {
  return specLabel(path.replace(/\\/g, '/'), PIECE)
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function configFacts(text: string | null, where: string, dir: string): ConfigFacts | null {
  if (text === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text.replace(/^﻿/, ''))
  } catch {
    return { where, dir, mode: null, app: null, org: null, universeName: null, universeLocal: null }
  }
  const o = asObject(parsed)
  return {
    where,
    dir,
    mode: str(asObject(o.topology).mode),
    app: str(asObject(o.app).name),
    org: str(asObject(o.app).org),
    universeName: str(asObject(o.universe).name),
    universeLocal: str(asObject(o.universe).local),
  }
}

function git(executor: GitExecutor, cwd: string, args: string[]): string | null {
  const r = executor(cwd, args)
  return r.ok ? r.stdout : null
}

function blobAt(executor: GitExecutor, cwd: string, rev: string, path: string): { state: 'present'; text: string } | { state: 'missing' } | { state: 'failed' } {
  const listed = executor(cwd, ['ls-tree', '-z', rev, '--', path])
  if (!listed.ok) return { state: 'failed' }
  const entry = listed.stdout.split('\0').find((e) => e.length > 0)
  if (entry === undefined) return { state: 'missing' }
  const sha = /^\d+ blob ([0-9a-f]{40,64})\t/.exec(entry)?.[1]
  if (sha === undefined) return { state: 'missing' }
  const blob = executor(cwd, ['cat-file', 'blob', sha])
  return blob.ok ? { state: 'present', text: blob.stdout } : { state: 'failed' }
}

function commitOf(executor: GitExecutor, cwd: string, rev: string): string | null {
  const out = git(executor, cwd, ['rev-parse', '--verify', '-q', `${rev}^{commit}`])
  const id = out?.trim() ?? ''
  return /^[0-9a-f]{40,64}$/.test(id) ? id : null
}

function readConfigSources(projectRoot: string, config: RsctConfig | null, executor: GitExecutor): ConfigFacts[] {
  const top = git(executor, projectRoot, ['rev-parse', '--show-toplevel'])?.trim() || null
  const root = canonicalPath(resolve(projectRoot))
  const topDir = top !== null ? canonicalPath(resolve(top)) : root
  const dirs: string[] = []
  let current = root
  for (;;) {
    dirs.push(current)
    if (rootKey(current) === rootKey(topDir)) break
    const up = dirname(current)
    if (up === current) break
    current = up
  }
  const sources: ConfigFacts[] = []
  for (const dir of dirs) {
    const file = join(dir, '.rsct.json')
    let working: string | null = null
    try {
      working = existsSync(file) ? readFileSync(file, 'utf8') : null
    } catch {
      working = null
    }
    const fromWorking = configFacts(working, `${shortPath(relative(topDir, file) || '.rsct.json')} (working tree)`, dir)
    if (fromWorking !== null) sources.push(fromWorking)
    if (top !== null) {
      const rel = relative(topDir, file).replace(/\\/g, '/')
      const blob = blobAt(executor, topDir, 'HEAD', rel)
      if (blob.state === 'present') {
        const fromHead = configFacts(blob.text, `${shortPath(rel)} (HEAD)`, dir)
        if (fromHead !== null) sources.push(fromHead)
      }
    }
  }
  if (sources.length === 0 && config !== null) {
    sources.push({
      where: '.rsct.json',
      dir: root,
      mode: config.topology?.mode ?? null,
      app: config.app?.name ?? null,
      org: config.app?.org ?? null,
      universeName: config.universe?.name ?? null,
      universeLocal: config.universe?.local ?? null,
    })
  }
  return sources
}

function readRoot(path: string, executor: GitExecutor): RootFacts {
  const facts: RootFacts = { path, branch: null, head: null, upstreamRef: null, upstream: null, notes: [], graphs: [] }
  facts.graphs.push({ source: 'working tree', graph: readContracts(path) })
  const locate = executor(path, ['rev-parse', '--show-toplevel', '--show-prefix'])
  if (!locate.ok) {
    const why = (locate.stderr || locate.error || '').trim().split(/\r?\n/)[0] ?? ''
    facts.notes.push(`not a git repository, or git refused to read it${why.length > 0 ? ` (${specLabel(why, PIECE)})` : ''}, so only its working tree is read`)
    return facts
  }
  const [top, prefix = ''] = locate.stdout.split(/\r?\n/)
  const gitTop = top && top.length > 0 ? top : path
  const file = `${prefix}contracts.json`
  const symbolic = git(executor, path, ['symbolic-ref', '-q', 'HEAD'])?.trim() ?? ''
  facts.branch = symbolic.startsWith('refs/heads/') ? symbolic : null
  if (facts.branch === null) facts.notes.push('detached HEAD')
  facts.head = commitOf(executor, path, 'HEAD')
  const head = blobAt(executor, gitTop, 'HEAD', file)
  if (head.state === 'present') facts.graphs.push({ source: 'HEAD', graph: parseContracts(head.text) })
  else if (head.state === 'failed' && facts.head !== null) facts.notes.push('its HEAD could not be read')
  if (facts.branch !== null) {
    const upstream = git(executor, path, ['for-each-ref', '--format=%(upstream)', facts.branch])?.trim() ?? ''
    if (upstream.length === 0) {
      facts.notes.push('no upstream')
    } else {
      facts.upstreamRef = upstream
      facts.upstream = commitOf(executor, path, upstream)
      if (facts.upstream === null) facts.notes.push(`upstream ${shortPath(upstream)} not fetched`)
      else {
        const up = blobAt(executor, gitTop, facts.upstream, file)
        if (up.state === 'present') facts.graphs.push({ source: 'upstream', graph: parseContracts(up.text) })
        else if (up.state === 'failed') facts.notes.push('its upstream could not be read')
      }
    }
  }
  return facts
}

const CASE_BLIND = process.platform === 'win32' || process.platform === 'darwin'

function rootKey(path: string): string {
  const key = canonicalPath(path).replace(/\\/g, '/').replace(/\/+$/, '')
  return CASE_BLIND ? key.toLowerCase() : key
}

function scopeRecord(value: unknown): ScopeRecord | null {
  const o = asObject(value)
  if (typeof o.mode !== 'boolean' || !Array.isArray(o.apps) || !Array.isArray(o.roots)) return null
  const apps = o.apps.filter((a): a is string => typeof a === 'string')
  const roots: RootRecord[] = []
  for (const r of o.roots) {
    const root = asObject(r)
    if (typeof root.path !== 'string') return null
    const id = (v: unknown): string | null => (typeof v === 'string' ? v : null)
    const contracts: Record<string, string> = {}
    for (const [k, v] of Object.entries(asObject(root.contracts))) if (typeof v === 'string') contracts[k] = v
    roots.push({ path: root.path, branch: id(root.branch), head: id(root.head), upstream_ref: id(root.upstream_ref), upstream: id(root.upstream), contracts })
  }
  return { mode: o.mode, apps, roots }
}

function contentHash(contract: Contract): string {
  const ordered = { id: contract.id, producer: contract.producer, surface: [...contract.surface].sort(), consumers: [...contract.consumers].sort() }
  return createHash('sha256').update(JSON.stringify(ordered)).digest('hex').slice(0, 16)
}

function readBaseline(projectRoot: string, auditConfig?: RsctAuditConfig): { scopes: Record<string, ScopeRecord>; at: string | null } {
  let raw = ''
  try {
    const path = decideAuditPath(projectRoot, auditConfig).path
    if (existsSync(path)) raw = readFileSync(path, 'utf8')
  } catch {
    raw = ''
  }
  let newest: { scopes: Record<string, ScopeRecord>; at: string | null } = { scopes: {}, at: null }
  for (const line of raw.split('\n')) {
    if (!line.includes(UNIVERSE_BASELINE_EVENT)) continue
    try {
      const entry = JSON.parse(line.replace(/\r$/, '')) as Record<string, unknown>
      if (entry.event !== UNIVERSE_BASELINE_EVENT) continue
      const scopes: Record<string, ScopeRecord> = {}
      for (const [key, value] of Object.entries(asObject(entry.scopes))) {
        const scope = scopeRecord(value)
        if (scope !== null) scopes[key] = scope
      }
      newest = { scopes, at: typeof entry.ts === 'string' ? entry.ts : null }
    } catch {
      continue
    }
  }
  return newest
}

function isAncestor(executor: GitExecutor, cwd: string, older: string, newer: string): 'yes' | 'no' | 'unknown' {
  const r = executor(cwd, ['merge-base', '--is-ancestor', older, newer])
  if (r.ok) return 'yes'
  return r.exitCode === 1 ? 'no' : 'unknown'
}

function disagreement(sources: ConfigFacts[], field: 'mode' | 'app' | 'universeLocal', label: string): string | null {
  const seen = new Map<string, string[]>()
  for (const s of sources) {
    const value = s[field] ?? '(not set)'
    seen.set(value, [...(seen.get(value) ?? []), s.where])
  }
  if (seen.size < 2) return null
  const parts = [...seen.entries()].map(([value, where]) => `${specLabel(value, PIECE)} in ${where.join(', ')}`)
  return `⚠ The .rsct.json files the contract gate reads disagree on ${label}: ${parts.join('; ')}. The gate uses the strictest reading.`
}

export function gatherContractFacts(args: {
  projectRoot: string
  config: RsctConfig | null
  readPaths: () => readonly string[] | null
  executor: GitExecutor
  auditConfig?: RsctAuditConfig
  home?: string
  always?: boolean
}): ContractFacts | null {
  const { projectRoot, executor } = args
  const scopeKey = rootKey(projectRoot)
  const sources = readConfigSources(projectRoot, args.config, executor)
  const multiRepo = sources.some((s) => s.mode === 'multi-repo')
  const apps = [...new Set(sources.map((s) => s.app).filter((a): a is string => a !== null))].sort()
  const baseline = readBaseline(projectRoot, args.auditConfig)
  const recorded = baseline.scopes[scopeKey]
  const since = baseline.at !== null ? ` since ${baseline.at.slice(0, 10)}` : ''
  const lines: string[] = []
  const changes: string[] = []
  const change = (line: string): void => {
    lines.push(line)
    changes.push(line)
  }

  for (const [field, label] of [['mode', 'topology.mode'], ['app', 'app.name'], ['universeLocal', 'universe.local']] as const) {
    const line = disagreement(sources, field, label)
    if (line !== null) lines.push(line)
  }
  if (recorded !== undefined && recorded.mode && !multiRepo) change(`⚠ The contract gate was on (multi-repo)${since}, and no .rsct.json says multi-repo now.`)
  if (recorded !== undefined && recorded.apps.join('\n') !== apps.join('\n')) {
    change(`⚠ The app name the contract gate matches changed${since}: ${specLabel(recorded.apps.join(', ') || '(none)', PIECE)} → ${specLabel(apps.join(', ') || '(none)', PIECE)}.`)
  }

  const empty = (): ContractFacts => ({
    multiRepo,
    recordBaseline: recorded !== undefined,
    apps,
    note: null,
    ids: [],
    consumers: [],
    hits: [],
    contracts: [],
    universeLinked: false,
    inactive: false,
    lines,
    changes,
    record: [],
    baseline: baselineEntry(baseline.scopes, scopeKey, { mode: multiRepo, apps, roots: [] }),
  })
  if (!multiRepo && args.always !== true) return empty()
  const paths = args.readPaths()
  if (paths === null) return null

  const roots = new Map<string, string>()
  for (const s of sources) {
    const mini = { app: { name: s.app ?? '', org: s.org ?? '' }, universe: { name: s.universeName ?? undefined, local: s.universeLocal ?? undefined } } as unknown as RsctConfig
    const found = resolveUniverseRoot(mini, s.dir, args.home !== undefined ? { home: args.home } : {})
    if (found.kind === 'found') roots.set(rootKey(found.path), found.path)
  }
  for (const r of recorded?.roots ?? []) {
    if (!roots.has(rootKey(r.path)) && isUniverseDir(r.path)) roots.set(rootKey(r.path), r.path)
  }
  for (const r of recorded?.roots ?? []) {
    if (!roots.has(rootKey(r.path))) change(`⚠ The universe at ${shortPath(r.path)}, read by the contract gate${since}, is no longer found.`)
  }
  for (const [key, path] of roots) {
    if (recorded !== undefined && !recorded.roots.some((r) => rootKey(r.path) === key)) {
      change(`⚠ The contract gate now also reads the universe at ${shortPath(path)}, which it did not read${since}.`)
    }
  }

  const facts = [...roots.values()].map((path) => readRoot(path, executor))
  const all: Contract[] = []
  const hits: Contract[] = []
  const hitKeys = new Set<string>()
  let readable = false
  for (const root of facts) {
    for (const note of root.notes) lines.push(`Universe ${shortPath(root.path)}: ${note}.`)
    for (const { graph } of root.graphs) {
      if (!graph.available) continue
      readable = true
      all.push(...graph.contracts)
      for (const app of apps) {
        for (const hit of contractsTouchingPaths(graph, app, paths)) {
          const k = `${hit.id}\0${contentHash(hit)}`
          if (!hitKeys.has(k)) {
            hitKeys.add(k)
            hits.push(hit)
          }
        }
      }
    }
    const old = recorded?.roots.find((r) => rootKey(r.path) === rootKey(root.path))
    if (old !== undefined) {
      if (old.branch !== root.branch) {
        change(`⚠ The universe at ${shortPath(root.path)} is on another branch${since}: ${specLabel(old.branch ?? '(none)', PIECE)} → ${specLabel(root.branch ?? '(none)', PIECE)}.`)
      }
      for (const [label, was, now] of [['HEAD', old.head, root.head], ['upstream', old.upstream, root.upstream]] as const) {
        if (was === null || was === now) continue
        if (now === null) {
          change(`⚠ The universe ${label} at ${shortPath(root.path)} no longer resolves${since} (it was ${was.slice(0, ID_SHOWN)}).`)
          continue
        }
        const verdict = isAncestor(executor, root.path, was, now)
        if (verdict !== 'yes') {
          change(`⚠ The universe ${label} at ${shortPath(root.path)} moved backwards or to an unknown commit${since} (${was.slice(0, ID_SHOWN)} → ${now.slice(0, ID_SHOWN)}).`)
        }
      }
      const nowIds = new Map<string, Set<string>>()
      for (const { graph } of root.graphs) {
        if (!graph.available) continue
        for (const c of graph.contracts) nowIds.set(c.id, new Set([...(nowIds.get(c.id) ?? []), contentHash(c)]))
      }
      const anyReadable = root.graphs.some((g) => g.graph.available)
      if (anyReadable) {
        const gone = Object.keys(old.contracts).filter((id) => !nowIds.has(id)).sort()
        const changed = Object.entries(old.contracts).filter(([id, hash]) => nowIds.has(id) && !nowIds.get(id)!.has(hash)).map(([id]) => id).sort()
        if (gone.length > 0) change(`⚠ Contracts gone from the universe at ${shortPath(root.path)}${since}: ${specLabel(gone.join(', '), IDS_SHOWN)}.`)
        if (changed.length > 0) change(`⚠ Contracts changed in the universe at ${shortPath(root.path)}${since}: ${specLabel(changed.join(', '), IDS_SHOWN)}.`)
      } else if (Object.keys(old.contracts).length > 0) {
        change(`⚠ No contracts.json of the universe at ${shortPath(root.path)} can be read now; it held ${specLabel(Object.keys(old.contracts).sort().join(', '), IDS_SHOWN)}${since}.`)
      }
    }
  }
  if (recorded === undefined && multiRepo) change('Universe contracts: first record of what the contract gate reads.')

  const record = facts.map((r) => ({ root: r.path.replace(/\\/g, '/'), head: r.head, upstream: r.upstream }))
  const rootRecords: RootRecord[] = facts.map((r) => {
    const contracts: Record<string, string> = {}
    for (const { graph } of r.graphs) if (graph.available) for (const c of graph.contracts) contracts[c.id] ??= contentHash(c)
    return { path: r.path, branch: r.branch, head: r.head, upstream_ref: r.upstreamRef, upstream: r.upstream, contracts }
  })
  return {
    multiRepo,
    recordBaseline: multiRepo || recorded !== undefined,
    apps,
    note: readable ? null : facts.flatMap((r) => r.graphs.map((g) => g.graph.note)).find((n): n is string => n !== null) ?? null,
    ids: [...new Set(hits.map((h) => h.id))].sort(),
    consumers: affectedConsumers(hits),
    hits,
    contracts: all,
    universeLinked: roots.size > 0,
    inactive: !readable,
    lines,
    changes,
    record,
    baseline: baselineEntry(baseline.scopes, scopeKey, { mode: multiRepo, apps, roots: rootRecords }),
  }
}

function baselineEntry(scopes: Record<string, ScopeRecord>, key: string, scope: ScopeRecord): AuditEntry {
  return { event: UNIVERSE_BASELINE_EVENT, scopes: { ...scopes, [key]: scope } }
}

export function universeFactsChanged(facts: ContractFacts): boolean {
  return facts.changes.length > 0
}
