import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  resolveProjectRoot,
  __resetPlaceholderWarnings,
} from '../../src/lib/project-root.js'
import { appendAuditEntry } from '../../src/lib/audit-log.js'

let tmpRoot: string
let originalEnvRoot: string | undefined
let originalClaudeDir: string | undefined
let stderrSpy: { restore: () => void; calls: string[] }

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'rsct-pr-'))
  originalEnvRoot = process.env.RSCT_PROJECT_ROOT
  originalClaudeDir = process.env.CLAUDE_PROJECT_DIR
  process.env.RSCT_PROJECT_ROOT = tmpRoot
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

  it('round-trips install.create_universe_declined_at (DX-1b ask-once flag)', () => {
    writeConfig({
      ...VALID_MIN,
      install: {
        applied_at: '2026-01-01T00:00:00Z',
        mode: 'CREATE',
        canonical_source_added: false,
        create_universe_declined_at: '2026-06-24T10:00:00Z',
      },
    })
    const r = resolveProjectRoot()
    expect(r.rsct_installed).toBe(true)
    expect(r.config?.install?.create_universe_declined_at).toBe('2026-06-24T10:00:00Z')
    expect(readAuditEntries()).toHaveLength(0)
  })

  it('strips unknown top-level fields silently (forward-compat)', () => {
    writeConfig({ ...VALID_MIN, future_field: { whatever: true } })
    const r = resolveProjectRoot()
    expect(r.rsct_installed).toBe(true)
    expect((r.config as Record<string, unknown> | null)?.future_field).toBeUndefined()
    expect(readAuditEntries()).toHaveLength(0)
  })

  it('reports rsct_installed=false (no audit) when .rsct.json is missing', () => {
    const r = resolveProjectRoot()
    expect(r.rsct_installed).toBe(false)
    expect(r.config).toBeNull()
    expect(readAuditEntries()).toHaveLength(0)
  })
})

describe('lib/project-root — sql_dialect (#62)', () => {
  it('accepts each declared dialect', () => {
    for (const dialect of ['postgresql', 'mysql', 'none']) {
      writeConfig({ ...VALID_MIN, sql_dialect: dialect })
      const r = resolveProjectRoot()
      expect(r.rsct_installed).toBe(true)
      expect(r.config?.sql_dialect).toBe(dialect)
    }
  })

  it('rejects the whole config on an unknown dialect', () => {
    const stderr = spyStderr()
    try {
      writeConfig({ ...VALID_MIN, sql_dialect: 'postgres' })
      const r = resolveProjectRoot()
      expect(r.rsct_installed).toBe(false)
      expect(r.config).toBeNull()
    } finally {
      stderr.restore()
    }
  })
})

describe('lib/project-root — public_api (#62)', () => {
  it('reads the declared globs', () => {
    writeConfig({ ...VALID_MIN, public_api: ['src/index.ts', 'src/public/**'] })
    const r = resolveProjectRoot()
    expect(r.rsct_installed).toBe(true)
    expect(r.config?.public_api).toEqual(['src/index.ts', 'src/public/**'])
  })

  it('is absent when nothing declares it, so no surface is assumed public', () => {
    writeConfig({ ...VALID_MIN })
    expect(resolveProjectRoot().config?.public_api).toBeUndefined()
  })

  it('drops a malformed value instead of rejecting the whole config', () => {
    writeConfig({ ...VALID_MIN, public_api: 'src/index.ts' })
    const r = resolveProjectRoot()
    expect(r.rsct_installed).toBe(true)
    expect(r.config?.public_api).toBeUndefined()
  })

  it('drops an entry list holding an empty string', () => {
    writeConfig({ ...VALID_MIN, public_api: ['src/index.ts', ''] })
    expect(resolveProjectRoot().config?.public_api).toBeUndefined()
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

  it('accepts rsct_phase_review_complete in trust_allowed_for', () => {
    writeConfig({
      ...VALID_MIN,
      approval_modes: {
        trust_allowed_for: ['rsct_phase_code_complete', 'rsct_phase_review_complete'],
      },
    })
    const r = resolveProjectRoot()
    expect(r.rsct_installed).toBe(true)
    expect(r.config?.approval_modes?.trust_allowed_for).toContain(
      'rsct_phase_review_complete',
    )
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

  it('STRIPS unknown fields inside approval_modes (forward-compat) — config stays valid', () => {
    writeConfig({
      ...VALID_MIN,
      approval_modes: { trust_allowed_for: [], magic_bypass: true },
    })
    const r = resolveProjectRoot()
    expect(r.rsct_installed).toBe(true)
    expect(r.config?.approval_modes?.trust_allowed_for).toEqual([])
    expect((r.config?.approval_modes as Record<string, unknown>)?.magic_bypass).toBeUndefined()
  })

  it('still NULLS the config on an OUT-OF-BOUNDS known approval_modes field (HIGH-4 preserved)', () => {
    writeConfig({
      ...VALID_MIN,
      approval_modes: { plan_token_max_actions: 9999 },
    })
    const r = resolveProjectRoot()
    expect(r.rsct_installed).toBe(false)
    const errs = readAuditEntries()[0]!.validation_errors as Array<{ path: string }>
    expect(errs.some((e) => e.path.includes('plan_token_max_actions'))).toBe(true)
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

describe('lib/project-root — a rejected config is recorded once per hour (#93)', () => {
  const MALFORMED = '{ not valid json'
  const OVER = { ...VALID_MIN, approval_modes: { plan_token_max_actions: 9999 } }
  const UNDER = { ...VALID_MIN, approval_modes: { plan_token_max_actions: 0 } }
  const OTHER_KEY = { ...VALID_MIN, approval_modes: { plan_token_ttl_minutes: 1 } }
  const MINUTE_MS = 60 * 1000
  const HOUR_MS = 60 * MINUTE_MS
  const TAIL_BYTES = 64 * 1024

  const logPath = (): string => join(tmpRoot, '.rsct', 'audit.log')

  function reject(): void {
    expect(resolveProjectRoot().rsct_installed).toBe(false)
  }

  function violationLines(): string[] {
    if (!existsSync(logPath())) return []
    return readFileSync(logPath(), 'utf8')
      .split('\n')
      .filter((line) => /"event":"rsct_json\.(malformed|bounds_violation)"/.test(line))
  }

  function warnings(): number {
    return stderrSpy.calls.filter((chunk) => chunk.includes('.rsct.json rejected')).length
  }

  function stampedAt(shiftMs: number): string {
    return new Date(Date.now() + shiftMs).toISOString()
  }

  function restampLog(shiftMs: number): void {
    const stamp = stampedAt(shiftMs)
    const moved = readAuditEntries().map((entry) => JSON.stringify({ ...entry, ts: stamp }))
    writeFileSync(logPath(), `${moved.join('\n')}\n`, 'utf8')
  }

  function recentFiller(bytes: number): string {
    const line = `${JSON.stringify({ event: 'filler', pad: 'x'.repeat(100), ts: stampedAt(0) })}\n`
    return line.repeat(Math.ceil(bytes / line.length))
  }

  it('writes ONE entry for two consecutive identical malformed configs, and warns on each load', () => {
    writeConfigRaw(MALFORMED)
    reject()
    reject()
    expect(violationLines()).toHaveLength(1)
    expect(warnings()).toBe(2)
  })

  it('writes ONE entry for two consecutive identical bounds violations', () => {
    writeConfig(OVER)
    reject()
    reject()
    expect(violationLines()).toHaveLength(1)
  })

  it('writes a second entry when a different key is rejected', () => {
    writeConfig(OVER)
    reject()
    writeConfig(OTHER_KEY)
    reject()
    expect(violationLines()).toHaveLength(2)
  })

  it('writes a second entry when the same key fails a different bound', () => {
    writeConfig(OVER)
    reject()
    writeConfig(UNDER)
    reject()
    expect(violationLines()).toHaveLength(2)
  })

  it('writes a second entry when the JSON is malformed in a different way', () => {
    writeConfigRaw(MALFORMED)
    reject()
    writeConfigRaw('[1,')
    reject()
    expect(violationLines()).toHaveLength(2)
  })

  it('still writes ONE entry when a real audit event lands between two identical violations', () => {
    writeConfigRaw(MALFORMED)
    reject()
    appendAuditEntry(tmpRoot, { event: 'classify.verdict', tier: 'small' }, { enabled: true })
    reject()
    expect(violationLines()).toHaveLength(1)
  })

  it('bounds two alternating violations to one entry each', () => {
    for (const config of [OVER, OTHER_KEY, OVER, OTHER_KEY]) {
      writeConfig(config)
      reject()
    }
    expect(violationLines()).toHaveLength(2)
  })

  it('keeps deduplicating an identical entry that is 59 minutes old', () => {
    writeConfigRaw(MALFORMED)
    reject()
    restampLog(-59 * MINUTE_MS)
    reject()
    expect(violationLines()).toHaveLength(1)
  })

  it('records the violation again once the identical entry is 61 minutes old', () => {
    writeConfigRaw(MALFORMED)
    reject()
    restampLog(-61 * MINUTE_MS)
    reject()
    reject()
    expect(violationLines()).toHaveLength(2)
  })

  it('counts both ends of the hour as inside it', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const start = Date.now()
      writeConfigRaw(MALFORMED)
      reject()
      reject()
      vi.setSystemTime(start + HOUR_MS)
      reject()
      expect(violationLines()).toHaveLength(1)
      vi.setSystemTime(start + HOUR_MS + 1)
      reject()
      expect(violationLines()).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('finds a recent identical entry behind older history', () => {
    appendAuditEntry(tmpRoot, { event: 'classify.verdict', tier: 'small' }, { enabled: true })
    restampLog(-3 * HOUR_MS)
    writeConfigRaw(MALFORMED)
    reject()
    reject()
    expect(violationLines()).toHaveLength(1)
  })

  it('finds a recent identical entry in front of an older line', () => {
    writeConfigRaw(MALFORMED)
    reject()
    const older = { event: 'classify.verdict', tier: 'small', ts: stampedAt(-3 * HOUR_MS) }
    appendFileSync(logPath(), `${JSON.stringify(older)}\n`, 'utf8')
    reject()
    expect(violationLines()).toHaveLength(1)
  })

  it('does not let an entry stamped in the future silence the violation', () => {
    writeConfigRaw(MALFORMED)
    reject()
    restampLog(24 * HOUR_MS)
    reject()
    expect(violationLines()).toHaveLength(2)
  })

  it('ignores a future-stamped copy without losing the recent one', () => {
    writeConfigRaw(MALFORMED)
    reject()
    const [entry] = readAuditEntries()
    appendFileSync(logPath(), `${JSON.stringify({ ...entry, ts: stampedAt(24 * HOUR_MS) })}\n`, 'utf8')
    reject()
    expect(violationLines()).toHaveLength(2)
  })

  it('is not silenced by an identical entry that carries no usable stamp', () => {
    writeConfigRaw(MALFORMED)
    reject()
    const [entry] = readAuditEntries()
    const { ts: _stamp, ...body } = entry!
    const unstamped = [body, { ...body, ts: 'not a date' }, { ...body, ts: [stampedAt(0)] }]
    writeFileSync(logPath(), `${unstamped.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8')
    reject()
    expect(violationLines()).toHaveLength(4)
  })

  it('records the first violation when the audit log is absent', () => {
    writeConfigRaw(MALFORMED)
    expect(existsSync(logPath())).toBe(false)
    reject()
    expect(violationLines()).toHaveLength(1)
  })

  it('records the violation when the audit log exists but is empty', () => {
    mkdirSync(join(tmpRoot, '.rsct'), { recursive: true })
    writeFileSync(logPath(), '', 'utf8')
    writeConfigRaw(MALFORMED)
    reject()
    expect(violationLines()).toHaveLength(1)
  })

  it('records once past lines that are not audit entries', () => {
    const garbage = 'null\nnot json\n42\n"text"\n[1,2]\n{"event":"rsct_json.mal\n'
    mkdirSync(join(tmpRoot, '.rsct'), { recursive: true })
    writeFileSync(logPath(), garbage, 'utf8')
    writeConfigRaw(MALFORMED)
    reject()
    appendFileSync(logPath(), garbage, 'utf8')
    reject()
    expect(violationLines()).toHaveLength(1)
  })

  it('never throws when the audit log path is a directory', () => {
    mkdirSync(logPath(), { recursive: true })
    writeConfigRaw(MALFORMED)
    expect(() => resolveProjectRoot()).not.toThrow()
    reject()
  })

  it.skipIf(process.platform === 'win32')('records the violation when the log cannot be read but can be appended to', () => {
    mkdirSync(join(tmpRoot, '.rsct'), { recursive: true })
    writeFileSync(logPath(), '', 'utf8')
    chmodSync(logPath(), 0o200)
    writeConfigRaw(MALFORMED)
    reject()
    chmodSync(logPath(), 0o600)
    expect(violationLines()).toHaveLength(1)
  })

  it.runIf(process.platform === 'linux')('closes the log after reading it', () => {
    writeConfigRaw(MALFORMED)
    reject()
    const before = readdirSync('/proc/self/fd').length
    for (let i = 0; i < 50; i++) reject()
    expect(readdirSync('/proc/self/fd').length).toBeLessThanOrEqual(before)
  })

  it.runIf(process.platform === 'linux')('closes the log when reading it fails', () => {
    mkdirSync(logPath(), { recursive: true })
    writeConfigRaw(MALFORMED)
    reject()
    const before = readdirSync('/proc/self/fd').length
    for (let i = 0; i < 50; i++) reject()
    expect(readdirSync('/proc/self/fd').length).toBeLessThanOrEqual(before)
  })

  it('finds a recent identical entry 48 KB back', () => {
    writeConfigRaw(MALFORMED)
    reject()
    appendFileSync(logPath(), recentFiller(48 * 1024), 'utf8')
    reject()
    expect(violationLines()).toHaveLength(1)
  })

  it('consults only the tail of the log', () => {
    writeConfigRaw(MALFORMED)
    reject()
    appendFileSync(logPath(), recentFiller(100 * 1024), 'utf8')
    reject()
    reject()
    expect(violationLines()).toHaveLength(2)
  })

  it('lists every failure in full, however many harmless ones come first', () => {
    writeConfig({
      ...VALID_MIN,
      protected_branches: Array.from({ length: 10 }, () => ''),
      approval_modes: { timestamp_skew_seconds: 999_999 },
      audit: { enabled: false },
    })
    reject()
    const [entry] = readAuditEntries()
    const failures = entry!.validation_errors as Array<{ path: string; message: string }>
    expect(failures).toHaveLength(12)
    expect(failures.map((failure) => failure.path)).toEqual(
      expect.arrayContaining(['approval_modes.timestamp_skew_seconds', 'audit.enabled']),
    )
  })

  it('keeps a long message whole, and so appends an entry larger than the tail on every load', () => {
    writeConfig({ ...VALID_MIN, sql_dialect: 'x'.repeat(100_000) })
    reject()
    reject()
    expect(violationLines()).toHaveLength(2)
    expect(Buffer.byteLength(violationLines()[0]!)).toBeGreaterThan(TAIL_BYTES)
  })
})

describe('lib/project-root — CAP-49 precedence + ${...} placeholder defense', () => {
  it('honors explicit input.project_root over the launch override', () => {
    writeConfig(VALID_MIN)
    const otherDir = mkdtempSync(join(tmpdir(), 'rsct-other-'))
    try {
      process.env.RSCT_PROJECT_ROOT = otherDir
      const r = resolveProjectRoot(tmpRoot)
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
    writeConfig(VALID_MIN)
    process.env.RSCT_PROJECT_ROOT = tmpRoot
    const r = resolveProjectRoot('../somewhere')
    expect(r.rsct_installed).toBe(true)
    expect(r.root).toBe(tmpRoot)
    expect(stderrSpy.calls.join('')).toContain('relative path')
  })

  it('rejects a whitespace-only path value', () => {
    writeConfig(VALID_MIN)
    process.env.RSCT_PROJECT_ROOT = tmpRoot
    const r = resolveProjectRoot('   ')
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
    expect(count).toBe(1)
  })
})
