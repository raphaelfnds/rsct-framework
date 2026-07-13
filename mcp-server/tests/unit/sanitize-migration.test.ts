import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { sanitize, isAbsoluteEntry } from '../../src/scripts/sanitize-permissions.js'

let tmpRoot: string
beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'rsct-mig-'))
  mkdirSync(join(tmpRoot, '.claude'), { recursive: true })
})
afterEach(() => {
  if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true })
})

const settingsPath = () => join(tmpRoot, '.claude', 'settings.json')
const localPath = () => join(tmpRoot, '.claude', 'settings.local.json')
function writeSettings(o: unknown) {
  writeFileSync(settingsPath(), JSON.stringify(o, null, 2))
}
function readJson(p: string) {
  return JSON.parse(readFileSync(p, 'utf8'))
}
const noAudit = () => {}

describe('sanitize — isAbsoluteEntry (host-independent)', () => {
  it('flags POSIX and Windows absolute paths, not relative ones', () => {
    expect(isAbsoluteEntry('/home/x')).toBe(true)
    expect(isAbsoluteEntry('C:\\Users\\me\\repo')).toBe(true)
    expect(isAbsoluteEntry('C:/Users/me/repo')).toBe(true)
    expect(isAbsoluteEntry('../rel')).toBe(false)
    expect(isAbsoluteEntry('sub/dir')).toBe(false)
    expect(isAbsoluteEntry(42)).toBe(false)
  })
})

describe('sanitize — additionalDirectories migration (Trilha 2)', () => {
  it('migrates absolute dirs into settings.local.json and strips them from settings.json', () => {
    writeSettings({
      model: 'opus',
      permissions: { additionalDirectories: ['C:\\Users\\me\\universe', './rel-ok'] },
    })
    const r = sanitize(tmpRoot, { auditWriter: noAudit })
    const mig = r.files.find((f) => f.status === 'migrated')
    expect(mig?.stripped).toEqual(['C:\\Users\\me\\universe'])

    const settings = readJson(settingsPath())
    expect(settings.permissions.additionalDirectories).toEqual(['./rel-ok']) // absolute stripped
    expect(settings.model).toBe('opus') // other keys preserved

    const local = readJson(localPath())
    expect(local.permissions.additionalDirectories).toEqual(['C:\\Users\\me\\universe'])
  })

  it('LOCAL-WRITE-FIRST: aborts (settings.json untouched) when settings.local.json is malformed', () => {
    writeSettings({ permissions: { additionalDirectories: ['/abs/path'] } })
    writeFileSync(localPath(), '{ not valid json')
    const r = sanitize(tmpRoot, { auditWriter: noAudit })
    expect(r.files.some((f) => f.status === 'migration_skipped')).toBe(true)
    // settings.json still has the absolute entry (nothing lost)
    expect(readJson(settingsPath()).permissions.additionalDirectories).toEqual(['/abs/path'])
  })

  it('dedups against entries already present in local (no duplicate)', () => {
    writeSettings({ permissions: { additionalDirectories: ['/abs/shared'] } })
    writeFileSync(localPath(), JSON.stringify({ permissions: { additionalDirectories: ['/abs/shared'] } }))
    sanitize(tmpRoot, { auditWriter: noAudit })
    expect(readJson(localPath()).permissions.additionalDirectories).toEqual(['/abs/shared']) // not duplicated
    expect(readJson(settingsPath()).permissions.additionalDirectories).toEqual([]) // still stripped
  })

  it('is a no-op when there are no absolute dirs', () => {
    writeSettings({ permissions: { additionalDirectories: ['./a', 'sub/b'] } })
    const r = sanitize(tmpRoot, { auditWriter: noAudit })
    expect(r.files.some((f) => f.status === 'migrated' || f.status === 'migration_skipped')).toBe(false)
    expect(existsSync(localPath())).toBe(false)
  })

  it('creates settings.local.json when absent and preserves its other keys when present', () => {
    writeSettings({ permissions: { additionalDirectories: ['/abs/x'] } })
    writeFileSync(localPath(), JSON.stringify({ theme: 'dark', permissions: { allow: ['Bash(ls)'] } }))
    sanitize(tmpRoot, { auditWriter: noAudit })
    const local = readJson(localPath())
    expect(local.theme).toBe('dark')
    expect(local.permissions.allow).toEqual(['Bash(ls)'])
    expect(local.permissions.additionalDirectories).toEqual(['/abs/x'])
  })
})
