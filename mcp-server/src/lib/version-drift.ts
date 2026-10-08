import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  PROJECT_SETTINGS_FILES,
  readClaudeSettings,
  type SettingsFile,
} from './claude-settings.js'
import { isNewer } from './update-check.js'
import { RSCT_MCP_VERSION } from './version.js'

type HookEvent = 'SessionStart' | 'PreToolUse'

interface EnforcementScript {
  event: HookEvent
  marker: string
}

const ENFORCEMENT_SCRIPTS: ReadonlyMap<string, EnforcementScript> = new Map([
  [
    'sanitize-permissions.js',
    { event: 'SessionStart', marker: '.rsct/scripts/sanitize-permissions.js' },
  ],
  ['edit-scope-guard.js', { event: 'PreToolUse', marker: '.rsct/scripts/edit-scope-guard.js' }],
])

export const STAMP_RE = /^\s*\/\/\s*rsct-mcp\s+v=([0-9]\S*)/

const STAMP_LINE_RE = /^\s*\/\/\s*rsct-mcp\s+v=/

export type DriftSeverity = 'normal' | 'security'

export type ScriptState = 'current' | 'stale' | 'inert' | 'absent' | 'unreadable'

const INERT_GUARD_NAME = 'edit-scope-guard.js'
const INERT_GUARD_LINE = 'if (isCliEntry()) {'

export type RegistrationState = 'registered' | 'unregistered' | 'unknown'

export interface ScriptEvidence {
  name: string
  state: ScriptState
  security_relevant: boolean
  stamp_version: string | null
  registration: RegistrationState
}

export interface AffectedComponent {
  name: string
  state: ScriptState
  stamp_version: string | null
  registration: RegistrationState
}

export interface InstallDriftNotice {
  hint: string | null
  severity: DriftSeverity
  affected_components: AffectedComponent[]
}

function shippedScriptsDir(): string | null {
  try {
    return join(fileURLToPath(new URL('.', import.meta.url)), 'scripts')
  } catch {
    return null
  }
}

function readNormalized(path: string): string | null {
  try {
    return readFileSync(path, 'utf8').replace(/\r/g, '')
  } catch {
    return null
  }
}

function trimTrailingNewlines(text: string): string {
  return text.replace(/\n+$/, '')
}

function installedBody(text: string): string {
  const lines = text.split('\n')
  const from = STAMP_LINE_RE.test(lines[1] ?? '') ? 2 : 1
  return trimTrailingNewlines(lines.slice(from).join('\n'))
}

function shippedBody(text: string): string {
  return trimTrailingNewlines(text.split('\n').slice(1).join('\n'))
}

const shippedCopies = new Map<string, Buffer | null>()

function shippedCopy(name: string, shippedDir: string): Buffer | null {
  const source = join(shippedDir, name)
  if (!shippedCopies.has(source)) {
    let copy: Buffer | null = null
    try {
      const shipped = readFileSync(source, 'utf8').replace(/\r\n/g, '\n')
      const body = trimTrailingNewlines(shipped.split('\n').slice(1).join('\n'))
      copy = Buffer.from(`#!/usr/bin/env node\n// rsct-mcp v=${RSCT_MCP_VERSION} — installed by /rsct-setup\n${body}\n`, 'utf8')
    } catch {
      copy = null
    }
    shippedCopies.set(source, copy)
  }
  return shippedCopies.get(source) ?? null
}

function withoutCrlf(bytes: Uint8Array): Buffer {
  const out: number[] = []
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x0d && bytes[i + 1] === 0x0a) continue
    out.push(bytes[i]!)
  }
  return Buffer.from(out)
}

export function isShippedScriptCopy(
  projectPath: string,
  bytes: Uint8Array,
  shippedDir: string | null = shippedScriptsDir(),
): boolean {
  if (shippedDir === null) return false
  const prefix = '.rsct/scripts/'
  if (!projectPath.startsWith(prefix)) return false
  const name = projectPath.slice(prefix.length)
  if (!ENFORCEMENT_SCRIPTS.has(name)) return false
  const expected = shippedCopy(name, shippedDir)
  return expected !== null && withoutCrlf(bytes).equals(expected)
}

function stampOf(text: string): string | null {
  const line2 = text.split('\n')[1] ?? ''
  const m = STAMP_RE.exec(line2)
  return m ? (m[1] ?? null) : null
}

function hookCommands(data: unknown, event: HookEvent): string[] {
  const asRecord = (v: unknown): Record<string, unknown> | null =>
    typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null

  const groups = asRecord(asRecord(data)?.hooks)?.[event]
  if (!Array.isArray(groups)) return []

  const commands: string[] = []
  for (const group of groups) {
    const inner = asRecord(group)?.hooks
    if (!Array.isArray(inner)) continue
    for (const entry of inner) {
      const command = asRecord(entry)?.command
      if (typeof command === 'string') commands.push(command)
    }
  }
  return commands
}

function readRegistration(settings: SettingsFile[], script: EnforcementScript): RegistrationState {
  if (settings.length === 0) return 'unknown'

  let complete = true
  for (const file of settings) {
    if (file.status === 'absent') continue
    if (file.status !== 'ok') {
      complete = false
      continue
    }
    for (const command of hookCommands(file.data, script.event)) {
      if (command.replace(/\\/g, '/').includes(script.marker)) return 'registered'
    }
  }
  return complete ? 'unregistered' : 'unknown'
}

export function readScriptRegistration(projectRoot: string, name: string): RegistrationState {
  const script = ENFORCEMENT_SCRIPTS.get(name)
  if (!script) return 'unknown'
  return readRegistration(readClaudeSettings(projectRoot), script)
}

export function readScriptEvidence(
  projectRoot: string,
  shippedDir: string | null = shippedScriptsDir(),
): ScriptEvidence[] {
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) return []
  const installedDir = join(projectRoot, '.rsct', 'scripts')
  const settings = readClaudeSettings(projectRoot)
  const registrationOf = (name: string): RegistrationState => {
    const script = ENFORCEMENT_SCRIPTS.get(name)
    return script ? readRegistration(settings, script) : 'unknown'
  }

  let entries: string[] = []
  let listed = true
  try {
    entries = readdirSync(installedDir).filter((f) => f.endsWith('.js'))
  } catch (err) {
    listed = (err as NodeJS.ErrnoException)?.code === 'ENOENT'
  }

  const names = [...new Set([...entries, ...ENFORCEMENT_SCRIPTS.keys()])].sort()
  const evidence: ScriptEvidence[] = []

  for (const name of names) {
    const security_relevant = ENFORCEMENT_SCRIPTS.has(name)
    const registration = registrationOf(name)

    if (!entries.includes(name)) {
      evidence.push({
        name,
        state: listed ? 'absent' : 'unreadable',
        security_relevant,
        stamp_version: null,
        registration,
      })
      continue
    }

    const installed = readNormalized(join(installedDir, name))
    if (installed === null) {
      evidence.push({
        name,
        state: 'unreadable',
        security_relevant,
        stamp_version: null,
        registration,
      })
      continue
    }

    const stamp_version = stampOf(installed)
    if (name === INERT_GUARD_NAME && installed.split('\n').includes(INERT_GUARD_LINE)) {
      evidence.push({ name, state: 'inert', security_relevant, stamp_version, registration })
      continue
    }
    const shipped = shippedDir === null ? null : readNormalized(join(shippedDir, name))
    if (shipped === null) {
      evidence.push({ name, state: 'unreadable', security_relevant, stamp_version, registration })
      continue
    }

    const a = installedBody(installed)
    const b = shippedBody(shipped)
    const state: ScriptState = a.length === 0 || b.length === 0 ? 'stale' : a === b ? 'current' : 'stale'
    evidence.push({ name, state, security_relevant, stamp_version, registration })
  }

  return evidence
}

function describeNotRunning(c: AffectedComponent): string {
  if (c.state === 'absent') return `${c.name} is not installed`
  if (c.state === 'inert') {
    return (
      `${c.name} is installed, but it is a build that cannot block an edit ` +
      `(every rsct-mcp from 2.2.0 to 2.12.3 shipped it that way)`
    )
  }
  const event = ENFORCEMENT_SCRIPTS.get(c.name)?.event
  const searched = PROJECT_SETTINGS_FILES.map((f) => `.claude/${f}`).join(' or ')
  return (
    `${c.name} is installed, but no ${event ?? 'hook'} entry pointing at it was found in ` +
    `this project's ${searched}`
  )
}

function describeStale(c: AffectedComponent): string {
  const at = c.stamp_version ? ` (installed at v${c.stamp_version})` : ''
  return `${c.name} differs from this binary's copy${at}`
}

function isNotRunning(e: ScriptEvidence): boolean {
  if (e.state === 'absent' || e.state === 'inert') return true
  if (e.state === 'current' || e.state === 'stale') return e.registration === 'unregistered'
  return false
}

export function getInstallDriftNotice(args: {
  projectRoot: string
  projectVersion: string | null | undefined
  mcpVersion: string
  evidence?: ScriptEvidence[]
}): InstallDriftNotice {
  const { projectRoot, projectVersion, mcpVersion } = args
  const evidence = args.evidence ?? readScriptEvidence(projectRoot)

  const toComponent = (e: ScriptEvidence): AffectedComponent => ({
    name: e.name,
    state: e.state,
    stamp_version: e.stamp_version,
    registration: e.registration,
  })

  const relevant = evidence.filter((e) => e.security_relevant)
  const notRunning = relevant.filter(isNotRunning).map(toComponent)
  const affected_components: AffectedComponent[] = relevant
    .filter((e) => isNotRunning(e) || e.state === 'stale')
    .map(toComponent)

  const m = mcpVersion.replace(/^v/, '')

  if (notRunning.length > 0) {
    return {
      severity: 'security',
      affected_components,
      hint:
        `⚠ SECURITY: RSCT enforcement is not running in this project — ` +
        `${notRunning.map(describeNotRunning).join('; ')}. ` +
        `Run /rsct-setup to repair it, then restart the IDE. ` +
        `See docs/troubleshooting.md. (never blocks)`,
    }
  }

  if (affected_components.length > 0) {
    return {
      severity: 'normal',
      affected_components,
      hint:
        `This project's RSCT enforcement scripts are not the ones rsct-mcp v${m} ships — ` +
        `${affected_components.map(describeStale).join('; ')}. ` +
        `That usually just means the project has not been re-synced since an update; re-run /rsct-setup. (suggestion only)`,
    }
  }

  if (!projectVersion) return { hint: null, severity: 'normal', affected_components: [] }
  if (!isNewer(mcpVersion, projectVersion))
    return { hint: null, severity: 'normal', affected_components: [] }

  const p = projectVersion.replace(/^v/, '')
  return {
    severity: 'normal',
    affected_components: [],
    hint:
      `This project was set up with RSCT v${p}; the installed rsct-mcp is v${m}. ` +
      `Re-run /rsct-setup to apply the current version's rules/prompts to this project. (suggestion only)`,
  }
}
