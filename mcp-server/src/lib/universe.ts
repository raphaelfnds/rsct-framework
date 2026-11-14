import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import type { RsctConfig } from './project-root.js'
import {
  readUniverseGovernanceIndex,
  EMPTY_GOVERNANCE_INDEX,
  type UniverseGovernanceIndex,
} from './universe-content.js'

export interface UniverseBlock {
  available: boolean
  name: string | null
  local_path: string | null
  registered_apps_count: number
  this_app_registered: boolean
  note: string | null
  governance: UniverseGovernanceIndex
}

export interface UniverseResult {
  block: UniverseBlock
  hint: string | null
}

export interface UniverseOptions {
  home?: string
}

const NONE_BLOCK: UniverseBlock = {
  available: false,
  name: null,
  local_path: null,
  registered_apps_count: 0,
  this_app_registered: false,
  note: null,
  governance: EMPTY_GOVERNANCE_INDEX,
}

const MAX_UNIVERSE_JSON_BYTES = 1_000_000

const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin'

type Resolution =
  | { kind: 'found'; path: string }
  | { kind: 'configured-missing'; path: string }
  | { kind: 'none' }

export function isUniverseDir(dir: string): boolean {
  try {
    return statSync(dir).isDirectory() && existsSync(join(dir, '.universe.json'))
  } catch {
    return false
  }
}

export function normalizeOrg(org: string | null | undefined): string | null {
  return org ? org.replace(/-\d*$/, '') : null
}

export function universeCandidates(
  projectRoot: string,
  basenames: string[],
  home: string,
  includeOrgBlind: boolean,
): string[] {
  const candidates: string[] = []
  for (const b of basenames) candidates.push(resolve(projectRoot, '..', `${b}-universe`))
  if (includeOrgBlind) candidates.push(resolve(projectRoot, '..', 'universe'))
  for (const sub of ['projetos', 'projects', 'dev', 'workspace']) {
    for (const b of basenames) candidates.push(join(home, sub, `${b}-universe`))
  }
  return candidates
}

export function discoverUniverseCandidate(
  projectRoot: string,
  orgKey: string | null | undefined,
  opts: UniverseOptions = {},
): string | null {
  try {
    const raw = orgKey?.trim() || null
    if (!raw) return null
    const inferred = normalizeOrg(raw)
    const basenames = [
      ...new Set(
        [inferred, raw].filter(
          (x): x is string => !!x && !/[\\/]/.test(x) && x !== '.' && x !== '..',
        ),
      ),
    ]
    if (basenames.length === 0) return null
    const home = opts.home ?? process.env.HOME ?? homedir()
    const self = resolve(projectRoot)
    const selfKey = CASE_INSENSITIVE_FS ? self.toLowerCase() : self
    for (const c of universeCandidates(projectRoot, basenames, home, false)) {
      const cKey = CASE_INSENSITIVE_FS ? resolve(c).toLowerCase() : resolve(c)
      if (cKey === selfKey) continue
      if (isUniverseDir(c)) return c
    }
    return null
  } catch {
    return null
  }
}

export function resolveUniverseRoot(
  config: RsctConfig | null,
  projectRoot: string,
  opts: UniverseOptions = {},
): Resolution {
  const uni = config?.universe
  const home = opts.home ?? process.env.HOME ?? homedir()

  if (uni?.local && uni.local.trim().length > 0) {
    const local = isAbsolute(uni.local) ? uni.local : resolve(projectRoot, uni.local)
    return isUniverseDir(local) ? { kind: 'found', path: local } : { kind: 'configured-missing', path: local }
  }

  const name = uni?.name ?? null
  const org = config?.app?.org ?? null
  const inferred = normalizeOrg(org)
  const basenames = [...new Set([name, inferred, org].filter((x): x is string => !!x))]
  const candidates = universeCandidates(projectRoot, basenames, home, true)

  for (const c of candidates) {
    if (c && isUniverseDir(c)) return { kind: 'found', path: c }
  }
  return { kind: 'none' }
}

interface UniverseData {
  name: string | null
  registeredFromJson: string[]
  registeredFromDirs: string[]
}

export function readUniverse(universeRoot: string): UniverseData | null {
  try {
    const jsonPath = join(universeRoot, '.universe.json')
    if (statSync(jsonPath).size > MAX_UNIVERSE_JSON_BYTES) return null
    const parsed = JSON.parse(readFileSync(jsonPath, 'utf8')) as {
      name?: unknown
      registered_apps?: unknown
    }
    const name = typeof parsed.name === 'string' ? parsed.name : null
    const registeredFromJson = Array.isArray(parsed.registered_apps)
      ? parsed.registered_apps.filter((x): x is string => typeof x === 'string')
      : []
    let registeredFromDirs: string[] = []
    try {
      registeredFromDirs = readdirSync(join(universeRoot, 'applications'), { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('_'))
        .map((e) => e.name)
    } catch {
      registeredFromDirs = []
    }
    return { name, registeredFromJson, registeredFromDirs }
  } catch {
    return null
  }
}

export function getUniverse(
  config: RsctConfig | null,
  projectRoot: string,
  opts: UniverseOptions = {},
): UniverseResult {
  if (!config) return { block: NONE_BLOCK, hint: null }

  let resolution: Resolution
  try {
    resolution = resolveUniverseRoot(config, projectRoot, opts)
  } catch {
    return { block: NONE_BLOCK, hint: null }
  }

  if (resolution.kind === 'none') return { block: NONE_BLOCK, hint: null }

  if (resolution.kind === 'configured-missing') {
    const note = `universe configured but not found at ${resolution.path}`
    return {
      block: { ...NONE_BLOCK, name: config.universe?.name ?? null, local_path: resolution.path, note },
      hint: `Universe configured at ${resolution.path} but not found there — fix .rsct.json universe.local or re-run /rsct-universe.`,
    }
  }

  const data = readUniverse(resolution.path)
  if (!data) {
    const note = `universe found but unreadable at ${resolution.path}`
    return {
      block: { ...NONE_BLOCK, name: config.universe?.name ?? null, local_path: resolution.path, note },
      hint: `Universe at ${resolution.path} is present but its .universe.json is missing/corrupt — inspect it.`,
    }
  }

  const appName = config.app?.name ?? null
  const inDirs = appName !== null && data.registeredFromDirs.includes(appName)
  const inJson = appName !== null && data.registeredFromJson.includes(appName)
  const thisAppRegistered = inDirs || inJson

  let note: string | null = null
  if (appName !== null && inJson !== inDirs) {
    note = inJson
      ? `app "${appName}" is listed in .universe.json but has no applications/${appName}/ dir`
      : `app "${appName}" has an applications/${appName}/ dir but is missing from .universe.json registered_apps`
  }

  const block: UniverseBlock = {
    available: true,
    name: data.name ?? config.universe?.name ?? null,
    local_path: resolution.path,
    registered_apps_count: data.registeredFromDirs.length,
    this_app_registered: thisAppRegistered,
    note,
    governance: readUniverseGovernanceIndex(resolution.path),
  }

  const hint =
    !thisAppRegistered && appName !== null
      ? `Universe found at ${resolution.path}; this app ("${appName}") is not registered there. Run /rsct-setup to register it.`
      : null

  return { block, hint }
}
