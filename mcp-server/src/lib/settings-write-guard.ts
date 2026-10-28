import { readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { decodeUnicodeEscapes } from './terminal-guard.js'

export const RSCT_HOOK_MARKERS: readonly string[] = [
  '.rsct/scripts/sanitize-permissions.js',
  '.rsct/scripts/edit-scope-guard.js',
  '.rsct/scripts/terminal-guard.js',
]

export type SettingsWriteVerdict = { block: false } | { block: true; reason: string }

type Reader = (path: string) => string | null

const PASS: SettingsWriteVerdict = { block: false }

function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

function bare(name: string): string {
  return name.replace(/::\$data$/i, '').replace(/[. ]+$/, '').toLowerCase()
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

function anySpellingNames(filePath: string, names: (path: string) => boolean): boolean {
  const lexical = resolve(filePath)
  const realDir = realOrNull(dirname(lexical))
  const candidates = [lexical, realOrNull(lexical), realDir === null ? null : join(realDir, basename(lexical))]
  return candidates.some((c) => c !== null && names(c))
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
    if (!(key in was) || !(key in now) || stable(was[key]) !== stable(now[key])) return key
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
  if (toolName !== 'Write' && toolName !== 'Edit' && toolName !== 'MultiEdit') return PASS
  if (!anySpellingNames(filePath, namesRsctConfig)) return PASS
  const current = lf(read(filePath) ?? '')
  const applied = resultingText(toolName, input, current)
  if (applied === null) return PASS
  if (applied.missed) return { block: true, reason: INEXACT_EDIT }
  const after = applied.text
  const afterJson = parseObject(after)
  const beforeJson = parseObject(current)
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
  if (toolName !== 'Write' && toolName !== 'Edit' && toolName !== 'MultiEdit') return PASS
  if (!isClaudeSettingsFile(filePath)) return PASS
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
    return PASS
  }
  const envKey = changedEnvKey(beforeJson, afterJson)
  if (envKey !== null) {
    return { block: true, reason: `this write would add, change or remove env.${envKey} in a Claude Code settings file; every env entry is the developer's own edit` }
  }
  return PASS
}
