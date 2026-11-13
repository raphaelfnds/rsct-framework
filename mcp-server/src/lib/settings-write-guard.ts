import { readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { bareName, pathComponents } from './protected-paths.js'
import { canonicalPath } from './repo-anchor.js'
import { decodeUnicodeEscapes } from './terminal-guard.js'

export const RSCT_HOOK_MARKERS: readonly string[] = [
  '.rsct/scripts/sanitize-permissions.js',
  '.rsct/scripts/edit-scope-guard.js',
  '.rsct/scripts/terminal-guard.js',
]

export type SettingsWriteVerdict = { block: false } | { block: true; reason: string }

type Reader = (path: string) => string | null

const PASS: SettingsWriteVerdict = { block: false }

const EDITOR_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

export const COMMAND_KEYS: readonly string[] = [
  'statusLine',
  'apiKeyHelper',
  'awsAuthRefresh',
  'awsCredentialExport',
  'gcpAuthRefresh',
  'otelHeadersHelper',
  'fileSuggestion',
  'policyHelper',
  'processWrapper',
  'sshHostCommands',
  'spellcheck',
  'sandbox',
  'enabledPlugins',
  'extraKnownMarketplaces',
  'pluginConfigs',
  'appendPlugins',
  'prependPlugins',
  'enableAllProjectMcpServers',
  'enabledMcpjsonServers',
  'disabledMcpjsonServers',
  'allowedMcpServers',
  'deniedMcpServers',
  'managedMcpServers',
  'allowManagedHooksOnly',
  'allowedChannelPlugins',
  'disableCommandPluginSources',
]

const NAMED_KEYS = new RegExp(`\\b(hooks|${COMMAND_KEYS.join('|')})\\b`, 'i')

const WHOLE_FILES: ReadonlyMap<string, string> = new Map([
  ['.mcp.json', 'the project MCP server registrations'],
  ['.claude.json', "Claude Code's MCP servers, approvals and folder trust"],
  ['managed-settings.json', 'managed Claude Code settings'],
  ['managed-mcp.json', 'managed MCP servers'],
])

function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

function bare(name: string): string {
  return bareName(name)
}

function realOrNull(path: string): string | null {
  try {
    return realpathSync.native(path)
  } catch {
    return null
  }
}

function namesSettingsFile(path: string): boolean {
  const name = bare(basename(path))
  return (name === 'settings.json' || name === 'settings.local.json') && bare(basename(dirname(path))) === '.claude'
}

function namesRsctConfig(path: string): boolean {
  return bare(basename(path)) === '.rsct.json'
}

function spellings(filePath: string): string[] {
  const lexical = resolve(filePath)
  const realDir = realOrNull(dirname(lexical))
  return [canonicalPath(lexical), lexical, realOrNull(lexical), realDir === null ? null : join(realDir, basename(lexical))].filter((c): c is string => c !== null)
}

function anySpellingNames(filePath: string, names: (path: string) => boolean): boolean {
  return spellings(filePath).some(names)
}

function firstSpelling<T>(filePath: string, judge: (path: string) => T | null): T | null {
  for (const candidate of spellings(filePath)) {
    const found = judge(candidate)
    if (found !== null) return found
  }
  return null
}

function bareParts(path: string): string[] {
  return pathComponents(path)
}

function wholeFileKind(path: string): string | null {
  const parts = bareParts(path)
  const name = parts[parts.length - 1] ?? ''
  const named = WHOLE_FILES.get(name)
  if (named !== undefined) return named
  if (parts.includes('managed-settings.d')) return 'managed Claude Code settings'
  if (parts.includes('.claude-plugin')) return 'a Claude Code plugin definition'
  for (let i = 0; i < parts.length - 1; i++) {
    if (parts[i] !== '.claude') continue
    if (parts[i + 1] === 'plugins') return 'an installed Claude Code plugin'
    if (name === 'hooks.json') return 'Claude Code hooks'
  }
  return null
}

export function judgeClaudeConfigFile(toolName: string, filePath: string): SettingsWriteVerdict {
  if (!EDITOR_TOOLS.has(toolName)) return PASS
  const kind = firstSpelling(filePath, wholeFileKind)
  if (kind === null) return PASS
  return { block: true, reason: `this write would change ${kind}, which Claude Code runs or loads; that is the developer's own edit` }
}

type AssetKind = 'skill' | 'command' | 'agent'

function assetKind(path: string): AssetKind | null {
  const parts = bareParts(path)
  const name = parts[parts.length - 1] ?? ''
  for (let i = 0; i < parts.length - 2; i++) {
    if (parts[i] !== '.claude') continue
    const area = parts[i + 1]
    if (area === 'skills' && name === 'skill.md') return 'skill'
    if (area === 'commands' && name.endsWith('.md')) return 'command'
    if (area === 'agents' && name.endsWith('.md')) return 'agent'
  }
  return null
}

function frontmatter(text: string): string {
  const match = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(lf(text).replace(/^﻿/, ''))
  return match ? match[1]! : ''
}

function shellLines(text: string): string {
  const inline = lf(text).match(/!`[^`]*`/g) ?? []
  const fenced = text.match(/^```!.*$[\s\S]*?^```/gm) ?? []
  return JSON.stringify([...inline, ...fenced].sort())
}

export function judgeClaudeAssetWrite(
  toolName: string,
  input: Record<string, unknown>,
  filePath: string,
  read: Reader = readOrNull,
): SettingsWriteVerdict {
  if (!EDITOR_TOOLS.has(toolName)) return PASS
  const kind = firstSpelling(filePath, assetKind)
  if (kind === null) return PASS
  if (toolName === 'NotebookEdit') return { block: true, reason: `a Claude Code ${kind} file cannot be edited as a notebook` }
  const current = lf(read(filePath) ?? '')
  const applied = resultingText(toolName, input, current)
  if (applied === null) return PASS
  if (applied.missed) return { block: true, reason: INEXACT_EDIT }
  const before = frontmatter(current)
  const after = frontmatter(applied.text)
  if (before !== after && (/hooks/i.test(before) || /hooks/i.test(after))) {
    return { block: true, reason: `this write would add, change or remove the hooks of a Claude Code ${kind}, which run commands; that is the developer's own edit` }
  }
  if (shellLines(current) !== shellLines(applied.text)) {
    return { block: true, reason: `this write would add, change or remove a !\`command\` line in a Claude Code ${kind}, which runs before its text reaches the model; that is the developer's own edit` }
  }
  return PASS
}

export function isClaudeSettingsFile(filePath: string): boolean {
  return anySpellingNames(filePath, namesSettingsFile)
}

type Applied = { text: string; missed: boolean }

function applyEdit(applied: Applied, edit: unknown): Applied {
  if (!edit || typeof edit !== 'object') return applied
  const e = edit as Record<string, unknown>
  if (typeof e.old_string !== 'string' || typeof e.new_string !== 'string') return applied
  const from = lf(e.old_string)
  const to = lf(e.new_string)
  const text = applied.text
  if (from === '') return { text: text === '' ? to : text, missed: applied.missed || text !== '' }
  if (!text.includes(from)) return { text, missed: true }
  return { text: e.replace_all === true ? text.split(from).join(to) : text.replace(from, () => to), missed: applied.missed }
}

function lf(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

function resultingText(toolName: string, input: Record<string, unknown>, current: string): Applied | null {
  if (toolName === 'Write') return typeof input.content === 'string' ? { text: input.content, missed: false } : null
  if (toolName === 'Edit') return applyEdit({ text: current, missed: false }, input)
  if (toolName === 'MultiEdit') {
    if (!Array.isArray(input.edits)) return null
    return input.edits.reduce<Applied>((applied, edit) => applyEdit(applied, edit), { text: current, missed: false })
  }
  return null
}

const INEXACT_EDIT =
  'this edit does not quote the file exactly, so the guard cannot tell what it would write; an edit of this file must match its text exactly'

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text.replace(/^﻿/, '')) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function envEntries(json: Record<string, unknown> | null): Record<string, unknown> {
  const env = json?.env
  return env && typeof env === 'object' && !Array.isArray(env) ? (env as Record<string, unknown>) : {}
}

function changedEnvKey(before: Record<string, unknown> | null, after: Record<string, unknown>): string | null {
  const was = envEntries(before)
  const now = envEntries(after)
  for (const key of new Set([...Object.keys(was), ...Object.keys(now)])) {
    if (!Object.hasOwn(was, key) || !Object.hasOwn(now, key) || stable(was[key]) !== stable(now[key])) return key
  }
  return null
}

function markersIn(text: string): string {
  return decodeUnicodeEscapes(text).replace(/\\\\/g, '/').replace(/\\/g, '/')
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function rsctEntries(json: Record<string, unknown>): Array<{ key: string; marker: string }> {
  const hooks = json.hooks
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return []
  const found: Array<{ key: string; marker: string }> = []
  for (const [event, groups] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(groups)) continue
    for (const group of groups as unknown[]) {
      if (!group || typeof group !== 'object') continue
      const g = group as Record<string, unknown>
      if (!Array.isArray(g.hooks)) continue
      for (const hook of g.hooks as unknown[]) {
        const command = hook && typeof hook === 'object' ? (hook as Record<string, unknown>).command : undefined
        if (typeof command !== 'string') continue
        const marker = RSCT_HOOK_MARKERS.find((m) => markersIn(command).includes(m))
        if (marker !== undefined) found.push({ key: stable([event, g.matcher === undefined || g.matcher === '' ? null : g.matcher, hook]), marker })
      }
    }
  }
  return found
}

function hooksShape(hooks: unknown): string {
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return stable(hooks)
  const shaped: Record<string, unknown> = {}
  for (const [event, groups] of Object.entries(hooks as Record<string, unknown>)) {
    shaped[event] = Array.isArray(groups)
      ? groups.map((group) => {
          if (!group || typeof group !== 'object' || Array.isArray(group)) return group
          const { matcher, ...rest } = group as Record<string, unknown>
          return matcher === undefined || matcher === '' ? rest : { matcher, ...rest }
        })
      : groups
  }
  return stable(shaped)
}

function changedRsctEntry(before: Record<string, unknown>, after: Record<string, unknown>): string | null {
  const remaining = rsctEntries(after).map((e) => e.key)
  for (const entry of rsctEntries(before)) {
    const at = remaining.indexOf(entry.key)
    if (at === -1) return entry.marker
    remaining.splice(at, 1)
  }
  return null
}

const DATABASE_SWITCH_KEYS = ['database_guard', 'database_test_guard'] as const

export function judgeRsctConfigWrite(
  toolName: string,
  input: Record<string, unknown>,
  filePath: string,
  read: Reader = readOrNull,
): SettingsWriteVerdict {
  if (!EDITOR_TOOLS.has(toolName)) return PASS
  if (!anySpellingNames(filePath, namesRsctConfig)) return PASS
  if (toolName === 'NotebookEdit') return { block: true, reason: '.rsct.json cannot be edited as a notebook' }
  const current = lf(read(filePath) ?? '')
  const applied = resultingText(toolName, input, current)
  if (applied === null) return PASS
  if (applied.missed) return { block: true, reason: INEXACT_EDIT }
  const after = applied.text
  const afterJson = parseObject(after)
  const beforeJson = parseObject(current)
  if (afterJson === null && beforeJson !== null) {
    return { block: true, reason: "this write would leave .rsct.json unreadable, which switches every RSCT edit check off; that is the developer's own edit" }
  }
  if (afterJson !== null && stable((beforeJson ?? {}).audit) !== stable(afterJson.audit)) {
    return { block: true, reason: "this write would change where or whether RSCT keeps its audit log (\"audit\" in .rsct.json); that is the developer's own edit" }
  }
  for (const key of DATABASE_SWITCH_KEYS) {
    const offAfter = afterJson ? afterJson[key] === false : new RegExp(`"${key}"\\s*:\\s*false`, 'i').test(decodeUnicodeEscapes(after))
    const offBefore = beforeJson !== null && beforeJson[key] === false
    if (offAfter && !offBefore) {
      return { block: true, reason: `this write would switch the database guard off ("${key}": false in .rsct.json); that is the developer's own edit` }
    }
  }
  return PASS
}

export function judgeSettingsWrite(
  toolName: string,
  input: Record<string, unknown>,
  filePath: string,
  read: Reader = readOrNull,
): SettingsWriteVerdict {
  if (!EDITOR_TOOLS.has(toolName)) return PASS
  if (!isClaudeSettingsFile(filePath)) return PASS
  if (toolName === 'NotebookEdit') return { block: true, reason: 'a Claude Code settings file cannot be edited as a notebook' }
  const current = lf(read(filePath) ?? '')
  const applied = resultingText(toolName, input, current)
  if (applied === null) return PASS
  if (applied.missed) return { block: true, reason: INEXACT_EDIT }
  const after = applied.text

  const afterJson = parseObject(after)
  const beforeJson = parseObject(current)
  const decodedAfter = decodeUnicodeEscapes(after)

  const hooksOff = afterJson ? afterJson.disableAllHooks === true : /"disableAllHooks"\s*:\s*true/i.test(decodedAfter)
  if (hooksOff) {
    return { block: true, reason: 'this write would switch every Claude Code hook off ("disableAllHooks": true); that is the developer\'s own edit' }
  }

  if (beforeJson && rsctEntries(beforeJson).length > 0) {
    if (!afterJson) {
      return {
        block: true,
        reason: 'this write would leave a Claude Code settings file that holds RSCT hooks unreadable; that is the developer\'s own edit',
      }
    }
    const changed = changedRsctEntry(beforeJson, afterJson)
    if (changed !== null) {
      return {
        block: true,
        reason: `this write would change or remove the RSCT hook entry for ${basename(changed)}; that is the developer's own edit, or /rsct-setup and /rsct-uninstall`,
      }
    }
  } else {
    const beforeMarkers = markersIn(current)
    const afterMarkers = markersIn(after)
    for (const marker of RSCT_HOOK_MARKERS) {
      if (beforeMarkers.includes(marker) && !afterMarkers.includes(marker)) {
        return {
          block: true,
          reason: `this write would remove the RSCT hook for ${basename(marker)}; removing an RSCT hook is the developer's own edit, or /rsct-uninstall`,
        }
      }
    }
  }

  if (!afterJson) {
    if (/"env"\s*:/i.test(decodedAfter)) {
      return { block: true, reason: 'this write would leave a Claude Code settings file unreadable with an env block in it; every env entry is the developer\'s own edit' }
    }
    const held = beforeJson !== null && ['hooks', ...COMMAND_KEYS].some((k) => Object.hasOwn(beforeJson, k))
    if (held || NAMED_KEYS.test(decodedAfter)) {
      return { block: true, reason: "this write would leave a Claude Code settings file unreadable where it holds or names hooks or a key that runs a command; that is the developer's own edit" }
    }
    return PASS
  }
  const envKey = changedEnvKey(beforeJson, afterJson)
  if (envKey !== null) {
    return { block: true, reason: `this write would add, change or remove env.${envKey} in a Claude Code settings file; every env entry is the developer's own edit` }
  }
  const was = beforeJson ?? {}
  if (hooksShape(was.hooks) !== hooksShape(afterJson.hooks)) {
    return { block: true, reason: "this write would add, change or remove a hook entry in a Claude Code settings file; hooks run commands, so that is the developer's own edit" }
  }
  const key = COMMAND_KEYS.find((k) => stable(was[k]) !== stable(afterJson[k]))
  if (key !== undefined) {
    return { block: true, reason: `this write would add, change or remove ${key} in a Claude Code settings file; it runs a command or loads code, so that is the developer's own edit` }
  }
  return PASS
}
