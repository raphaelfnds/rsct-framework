import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  resolveProjectRoot,
  __resetPlaceholderWarnings,
} from '../../src/lib/project-root.js'

let tmpRoot: string
let originalEnvRoot: string | undefined
let originalClaudeDir: string | undefined
let stderrSpy: { restore: () => void; calls: string[] }

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'rsct-pr-'))
  originalEnvRoot = process.env.RSCT_PROJECT_ROOT
  originalClaudeDir = process.env.CLAUDE_PROJECT_DIR
  process.env.RSCT_PROJECT_ROOT = tmpRoot
  // Clean baseline: tests that exercise CLAUDE_PROJECT_DIR opt in explicitly.
  // Deleting here also shields the override-based tests from a CLAUDE_PROJECT_DIR
  // that may be present in the runner's own environment.
  delete process.env.CLAUDE_PROJECT_DIR
  __resetPlaceholderWarnings()
  stderrSpy = spyStderr()
})

afterEach(() => {
  stderrSpy.restore()
  if (originalEnvRoot === undefined) {
    delete process.env.RSCT_PROJECT_ROOT
  } else {
    process.env.RSCT_PROJECT_ROOT = originalEnvRoot
  }
  if (originalClaudeDir === undefined) {
    delete process.env.CLAUDE_PROJECT_DIR
  } else {
    process.env.CLAUDE_PROJECT_DIR = originalClaudeDir
  }
  if (existsSync(tmpRoot)) {
    rmSync(tmpRoot, { recursive: true, force: true })
  }
})

function writeConfig(body: unknown): void {
  writeFileSync(join(tmpRoot, '.rsct.json'), JSON.stringify(body), 'utf8')
}

function writeConfigRaw(raw: string): void {
  writeFileSync(join(tmpRoot, '.rsct.json'), raw, 'utf8')
}

function readAuditEntries(): Array<Record<string, unknown>> {
  const path = join(tmpRoot, '.rsct', 'audit.log')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

function spyStderr(): { restore: () => void; calls: string[] } {
  const original = process.stderr.write.bind(process.stderr)
  const calls: string[] = []
  process.stderr.write = ((chunk: unknown) => {
    if (typeof chunk === 'string') calls.push(chunk)
    return true
  }) as typeof process.stderr.write
  return { calls, restore: () => (process.stderr.write = original) }
}

const VALID_MIN = {
  rsct_version: '1.0.0',
  app: { name: 'sample', org: 'sample-org' },
}

describe('lib/project-root — readRsctConfig happy path', () => {
  it('loads a minimal valid config', () => {
    writeConfig(VALID_MIN)
    const r = resolveProjectRoot()
    expect(r.rsct_installed).toBe(true)
    expect(r.config?.rsct_version).toBe('1.0.0')
    expect(r.config?.app.name).toBe('sample')
  })

  it('loads a config with valid approval_modes + audit + protected_branches', () => {
    writeConfig({
      ...VALID_MIN,
      protected_branches: ['main', 'release'],
      approval_modes: {
        timestamp_skew_seconds: 300,
        trust_allowed_for: ['rsct_request_commit'],
      },
      audit: { enabled: true, path: 'logs/r.jsonl' },
    })
    const r = resolveProjectRoot()
    expect(r.rsct_installed).toBe(true)
    expect(r.config?.approval_modes?.timestamp_skew_seconds).toBe(300)
    expect(r.config?.audit?.path).toBe('logs/r.jsonl')
    expect(r.config?.protected_branches).toEqual(['main', 'release'])
  })

  it('strips unknown top-level fields silently (forward-compat)', () => {
    writeConfig({ ...VALID_MIN, future_field: { whatever: true } })
    const r = resolveProjectRoot()
    expect(r.rsct_installed).toBe(true)
    expect((r.config as Record<string, unknown> | null)?.future_field).toBeUndefined()
    // No tamper event for a stripped-unknown field — it's a benign extension.
    expect(readAuditEntries()).toHaveLength(0)
  })

  it('reports rsct_installed=false (no audit) when .rsct.json is missing', () => {
    const r = resolveProjectRoot()
    expect(r.rsct_installed).toBe(false)
    expect(r.config).toBeNull()
    expect(readAuditEntries()).toHaveLength(0)
  })
})

describe('lib/project-root — HIGH-4 bounds violations are rejected + audited', () => {
  it('rejects audit.enabled: false', () => {
    writeConfig({ ...VALID_MIN, audit: { enabled: false } })
    const r = resolveProjectRoot()
    expect(r.rsct_installed).toBe(false)
    expect(r.config).toBeNull()
    const entries = readAuditEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0]!.event).toBe('rsct_json.bounds_violation')
    expect(stderrSpy.calls.join('')).toContain('rsct_installed=false')
  })

  it('rejects timestamp_skew_seconds above max (600)', () => {
    writeConfig({
      ...VALID_MIN,
      approval_modes: { timestamp_skew_seconds: 999999 },
    })
    const r = resolveProjectRoot()
    expect(r.rsct_installed).toBe(false)
    const entries = readAuditEntries()
    expect(entries).toHaveLength(1)
    const errs = entries[0]!.validation_errors as Array<{ path: string }>
    expect(errs.some((e) => e.path.includes('timestamp_skew_seconds'))).toBe(true)
  })

  it('rejects timestamp_skew_seconds below min (60)', () => {
    writeConfig({
      ...VALID_MIN,
      approval_modes: { timestamp_skew_seconds: 5 },
    })
    const r = resolveProjectRoot()
    expect(r.rsct_installed).toBe(false)
    expect(readAuditEntries()).toHaveLength(1)
  })

  it('rejects empty protected_branches []', () => {
    writeConfig({ ...VALID_MIN, protected_branches: [] })
    const r = resolveProjectRoot()
    expect(r.rsct_installed).toBe(false)
    const errs = readAuditEntries()[0]!.validation_errors as Array<{ path: string }>
    expect(errs.some((e) => e.path.includes('protected_branches'))).toBe(true)
  })

  it('rejects trust_allowed_for with values outside the enum', () => {
    writeConfig({
      ...VALID_MIN,
      approval_modes: { trust_allowed_for: ['Bash', 'Edit'] },
    })
    const r = resolveProjectRoot()
    expect(r.rsct_installed).toBe(false)
    expect(readAuditEntries()).toHaveLength(1)
  })

  it('rejects unknown fields inside the strict audit sub-object', () => {
    writeConfig({
      ...VALID_MIN,
      audit: { enabled: true, force_disable: true },
    })
    const r = resolveProjectRoot()
    expect(r.rsct_installed).toBe(false)
    const errs = readAuditEntries()[0]!.validation_errors as Array<{ path: string }>
    expect(errs.some((e) => e.path.includes('audit'))).toBe(true)
  })

  it('rejects unknown fields inside the strict approval_modes sub-object', () => {
    writeConfig({
      ...VALID_MIN,
      approval_modes: { trust_allowed_for: [], magic_bypass: true },
    })
    const r = resolveProjectRoot()
    expect(r.rsct_installed).toBe(false)
    expect(readAuditEntries()).toHaveLength(1)
  })

  it('reports multiple violations in a single audit entry', () => {
    writeConfig({
      ...VALID_MIN,
      audit: { enabled: false },
      protected_branches: [],
      approval_modes: { timestamp_skew_seconds: 999999 },
    })
    const r = resolveProjectRoot()
    expect(r.rsct_installed).toBe(false)
    const entries = readAuditEntries()
    expect(entries).toHaveLength(1)
    const errs = entries[0]!.validation_errors as Array<unknown>
    expect(errs.length).toBeGreaterThanOrEqual(3)
  })

  it('forces the audit event even when the attacker tried to disable audit', () => {
    writeConfig({ ...VALID_MIN, audit: { enabled: false } })
    resolveProjectRoot()
    // Audit was written despite enabled:false in the rejected config —
    // tamper events must outlive the very vector they document.
    expect(existsSync(join(tmpRoot, '.rsct', 'audit.log'))).toBe(true)
  })
})

describe('lib/project-root — malformed JSON', () => {
  it('returns null + audits rsct_json.malformed when JSON.parse fails', () => {
    writeConfigRaw('{not: valid json')
    const r = resolveProjectRoot()
    expect(r.rsct_installed).toBe(false)
    const entries = readAuditEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0]!.event).toBe('rsct_json.malformed')
    expect(typeof entries[0]!.error).toBe('string')
  })

  it('returns null + audits when the file contains a non-object root', () => {
    writeConfigRaw('"a string at root"')
    const r = resolveProjectRoot()
    expect(r.rsct_installed).toBe(false)
    const entries = readAuditEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0]!.event).toBe('rsct_json.bounds_violation')
  })
})

describe('lib/project-root — CAP-49 precedence + ${...} placeholder defense', () => {
  it('honors explicit input.project_root over the launch override', () => {
    writeConfig(VALID_MIN) // .rsct.json lives in tmpRoot
    const otherDir = mkdtempSync(join(tmpdir(), 'rsct-other-'))
    try {
      process.env.RSCT_PROJECT_ROOT = otherDir // override points at a config-less dir
      const r = resolveProjectRoot(tmpRoot) // explicit arg must win
      expect(r.rsct_installed).toBe(true)
      expect(r.root).toBe(tmpRoot)
    } finally {
      rmSync(otherDir, { recursive: true, force: true })
    }
  })

  it('ignores an unsubstituted ${...} launch override and falls back to CLAUDE_PROJECT_DIR', () => {
    writeConfig(VALID_MIN)
    process.env.RSCT_PROJECT_ROOT = '${workspaceFolder}'
    process.env.CLAUDE_PROJECT_DIR = tmpRoot
    const r = resolveProjectRoot()
    expect(r.rsct_installed).toBe(true)
    expect(r.root).toBe(tmpRoot)
    expect(stderrSpy.calls.join('')).toContain('unsubstituted placeholder')
  })

  it('ignores a ${...} explicit arg and falls through to a valid override', () => {
    writeConfig(VALID_MIN)
    process.env.RSCT_PROJECT_ROOT = tmpRoot
    const r = resolveProjectRoot('${workspaceFolder}')
    expect(r.rsct_installed).toBe(true)
    expect(r.root).toBe(tmpRoot)
  })

  it('uses CLAUDE_PROJECT_DIR as the walk start when no explicit/override is set', () => {
    writeConfig(VALID_MIN)
    delete process.env.RSCT_PROJECT_ROOT
    process.env.CLAUDE_PROJECT_DIR = tmpRoot
    const r = resolveProjectRoot()
    expect(r.rsct_installed).toBe(true)
    expect(r.root).toBe(tmpRoot)
  })

  it('warns only once per source for a repeated placeholder value', () => {
    process.env.RSCT_PROJECT_ROOT = '${workspaceFolder}'
    delete process.env.CLAUDE_PROJECT_DIR
    resolveProjectRoot()
    resolveProjectRoot()
    const count = stderrSpy.calls.join('').split('unsubstituted placeholder').length - 1
    expect(count).toBe(1)
  })
})

describe('lib/project-root — CAP-50 path hardening', () => {
  it('rejects a relative explicit project_root (schema requires absolute)', () => {
    writeConfig(VALID_MIN) // .rsct.json in tmpRoot (absolute)
    process.env.RSCT_PROJECT_ROOT = tmpRoot // valid absolute override as fallback
    const r = resolveProjectRoot('../somewhere') // relative explicit → ignored
    expect(r.rsct_installed).toBe(true) // falls through to the absolute override
    expect(r.root).toBe(tmpRoot)
    expect(stderrSpy.calls.join('')).toContain('relative path')
  })

  it('rejects a whitespace-only path value', () => {
    writeConfig(VALID_MIN)
    process.env.RSCT_PROJECT_ROOT = tmpRoot
    const r = resolveProjectRoot('   ') // whitespace-only explicit → ignored
    expect(r.rsct_installed).toBe(true)
    expect(r.root).toBe(tmpRoot)
  })

  it('emits a one-time diagnostic when CLAUDE_PROJECT_DIR is used', () => {
    writeConfig(VALID_MIN)
    delete process.env.RSCT_PROJECT_ROOT
    process.env.CLAUDE_PROJECT_DIR = tmpRoot
    resolveProjectRoot()
    resolveProjectRoot()
    const joined = stderrSpy.calls.join('')
    expect(joined).toContain('CLAUDE_PROJECT_DIR')
    const count = joined.split('resolving project root from CLAUDE_PROJECT_DIR').length - 1
    expect(count).toBe(1) // one-time, not per-call
  })
})
