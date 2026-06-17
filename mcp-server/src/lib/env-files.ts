import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

import { maskIfSecret, type MaskReason } from './secrets.js'

export type EnvFormat = 'properties' | 'env'

export interface ParsedEntry {
  key: string
  value: string
  masked: boolean
  mask_reason?: MaskReason
}

export interface ParsedEnvFile {
  path: string
  format: EnvFormat
  profile: string | null
  entries: ParsedEntry[]
}

export interface DeltaModification {
  key: string
  base_value: string
  profile_value: string
  base_masked: boolean
  profile_masked: boolean
}

export interface ProfileDelta {
  profile: string
  format: EnvFormat
  base_path: string
  profile_path: string
  added: ParsedEntry[]
  modified: DeltaModification[]
}

export interface DiscoveredEnv {
  search_paths: string[]
  properties_files: string[]
  env_files: string[]
  yaml_files: string[]
}

/**
 * Common locations where Spring/Node projects store env files. Paths are
 * resolved relative to `projectRoot`. Missing dirs are skipped silently.
 */
const SEARCH_PATHS: readonly string[] = [
  '',
  'src/main/resources',
  'src/main/resources/config',
  'config',
  'resources',
] as const

export function discoverEnvFiles(projectRoot: string): DiscoveredEnv {
  const properties: string[] = []
  const envs: string[] = []
  const yamls: string[] = []
  const searched: string[] = []

  for (const sub of SEARCH_PATHS) {
    const dir = sub ? join(projectRoot, sub) : projectRoot
    if (!existsSync(dir)) continue
    let stat
    try {
      stat = statSync(dir)
    } catch {
      continue
    }
    if (!stat.isDirectory()) continue
    searched.push(dir)

    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }

    for (const name of names) {
      const full = join(dir, name)
      if (/^application(-.+)?\.properties$/i.test(name)) properties.push(full)
      else if (/^application(-.+)?\.ya?ml$/i.test(name)) yamls.push(full)
      else if (sub === '' && /^\.env(\..+)?$/i.test(name)) envs.push(full)
    }
  }

  const toRel = (p: string): string => relative(projectRoot, p).split('\\').join('/')

  return {
    search_paths: searched.map((p) => relative(projectRoot, p).split('\\').join('/') || '.'),
    properties_files: properties.map(toRel),
    env_files: envs.map(toRel),
    yaml_files: yamls.map(toRel),
  }
}

const PROFILE_REGEX = /^application-(.+)\.(properties|ya?ml)$/i

export function getProfileFromBasename(name: string): string | null {
  const m = name.match(PROFILE_REGEX)
  return m?.[1] ?? null
}

/**
 * Parse Java/Spring `.properties` content. Supports `#` and `!` line
 * comments, `key=value` and `key:value`, ignores blank lines. Multi-line
 * (trailing backslash) NOT supported in v1 — flagged as a follow-up.
 */
export function parseProperties(content: string): ParsedEntry[] {
  const out: ParsedEntry[] = []
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trimEnd()
    if (line.length === 0) continue
    const trimmed = line.trimStart()
    if (trimmed.startsWith('#') || trimmed.startsWith('!')) continue
    const separatorIndex = findSeparator(line)
    if (separatorIndex === -1) continue
    const key = line.slice(0, separatorIndex).trim()
    const value = line.slice(separatorIndex + 1).trim()
    if (key.length === 0) continue
    const mask = maskIfSecret(key, value)
    const entry: ParsedEntry = { key, value: mask.value, masked: mask.masked }
    if (mask.reason) entry.mask_reason = mask.reason
    out.push(entry)
  }
  return out
}

function findSeparator(line: string): number {
  let escaped = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (ch === '\\') {
      escaped = true
      continue
    }
    if (ch === '=' || ch === ':') return i
  }
  return -1
}

/**
 * Parse a `.env` style file. Supports `KEY=VALUE`, `export KEY=VALUE`,
 * `#` comments, and surrounding single/double quotes on the value.
 */
export function parseDotEnv(content: string): ParsedEntry[] {
  const out: ParsedEntry[] = []
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    const stripped = line.replace(/^export\s+/, '')
    const eq = stripped.indexOf('=')
    if (eq === -1) continue
    const key = stripped.slice(0, eq).trim()
    let value = stripped.slice(eq + 1).trim()
    if (key.length === 0) continue
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1)
    }
    const mask = maskIfSecret(key, value)
    const entry: ParsedEntry = { key, value: mask.value, masked: mask.masked }
    if (mask.reason) entry.mask_reason = mask.reason
    out.push(entry)
  }
  return out
}

export function parseEnvFileAt(projectRoot: string, relPath: string): ParsedEnvFile | null {
  const full = join(projectRoot, relPath)
  if (!existsSync(full)) return null
  let content: string
  try {
    content = readFileSync(full, 'utf8')
  } catch {
    return null
  }

  const basename = relPath.split('/').pop() ?? relPath
  const isProperties = /\.properties$/i.test(basename)
  const isEnv = /^\.env/.test(basename)
  if (!isProperties && !isEnv) return null

  const format: EnvFormat = isProperties ? 'properties' : 'env'
  const profile = isProperties ? getProfileFromBasename(basename) : null
  const entries = isProperties ? parseProperties(content) : parseDotEnv(content)

  return { path: relPath, format, profile, entries }
}

/**
 * Group profile files by their base file (same format, no profile suffix)
 * and compute the added/modified delta against that base. Profiles whose
 * base file is absent are still returned with `base_path` empty and the
 * full entry list as `added`.
 */
export function computeProfileDeltas(files: ParsedEnvFile[]): ProfileDelta[] {
  const base = new Map<EnvFormat, ParsedEnvFile>()
  for (const file of files) {
    if (file.profile === null && file.format === 'properties') {
      base.set(file.format, file)
    }
  }

  const out: ProfileDelta[] = []
  for (const file of files) {
    if (file.profile === null) continue
    const baseFile = base.get(file.format)
    const baseMap = new Map<string, ParsedEntry>()
    if (baseFile) {
      for (const e of baseFile.entries) baseMap.set(e.key, e)
    }

    const added: ParsedEntry[] = []
    const modified: DeltaModification[] = []

    for (const entry of file.entries) {
      const baseEntry = baseMap.get(entry.key)
      if (!baseEntry) {
        added.push(entry)
        continue
      }
      if (baseEntry.value !== entry.value || baseEntry.masked !== entry.masked) {
        modified.push({
          key: entry.key,
          base_value: baseEntry.value,
          profile_value: entry.value,
          base_masked: baseEntry.masked,
          profile_masked: entry.masked,
        })
      }
    }

    out.push({
      profile: file.profile,
      format: file.format,
      base_path: baseFile?.path ?? '',
      profile_path: file.path,
      added,
      modified,
    })
  }

  return out
}
