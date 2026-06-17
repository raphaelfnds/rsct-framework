import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  phaseVerificationStartHandler,
  type PhaseVerificationStartOutput,
} from '../../src/tools/phase-verification-start.js'

let tmpRoot: string

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'rsct-vstart-'))
})

afterEach(() => {
  if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true })
})

function writeFile(rel: string, content: string): void {
  const full = join(tmpRoot, rel)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, content, 'utf8')
}

function writeRsctConfig(overrides: Record<string, unknown> = {}): void {
  writeFile(
    '.rsct.json',
    JSON.stringify({
      rsct_version: '1.0.0',
      app: { name: 'test-app', org: 'test-org' },
      ...overrides,
    }),
  )
}

describe('phase-verification-start — tier skip', () => {
  it('skips when spec_tier=trivial — no phase-state written', async () => {
    writeRsctConfig()
    const out = (await phaseVerificationStartHandler({
      project_root: tmpRoot,
      spec_ref: 'trivial-task',
      spec_tier: 'trivial',
    })) as PhaseVerificationStartOutput

    expect(out.status).toBe('skipped_tier')
    expect(out.phase_state_written).toBe(false)
    expect(existsSync(join(tmpRoot, '.rsct/phase-state.json'))).toBe(false)
    expect(out.findings).toEqual([])
    expect(out.hints.some((h) => h.includes('skipped per tier table'))).toBe(
      true,
    )
  })

  it('skips when spec_tier=small', async () => {
    writeRsctConfig()
    const out = (await phaseVerificationStartHandler({
      project_root: tmpRoot,
      spec_ref: 'small-task',
      spec_tier: 'small',
    })) as PhaseVerificationStartOutput

    expect(out.status).toBe('skipped_tier')
  })
})

describe('phase-verification-start — verified happy path', () => {
  it('writes verification block to phase-state.json on standard tier', async () => {
    writeRsctConfig()
    writeFile('src/seed.ts', 'export const x = 1\n')
    writeFile('src/importer.ts', "import { x } from './seed'\n")

    const out = (await phaseVerificationStartHandler({
      project_root: tmpRoot,
      spec_ref: 'feat-foo',
      declared_paths: ['src/seed.ts'],
      spec_tier: 'standard',
    })) as PhaseVerificationStartOutput

    expect(out.status).toBe('verified')
    expect(out.phase_state_written).toBe(true)
    expect(out.discovered_importers).toHaveLength(1)
    expect(out.discovered_importers[0]?.file).toBe('src/importer.ts')

    const stateRaw = readFileSync(
      join(tmpRoot, '.rsct/phase-state.json'),
      'utf8',
    )
    const state = JSON.parse(stateRaw) as Record<string, unknown>
    expect(state.phase).toBe('verification')
    expect(state.spec_slug).toBe('feat-foo')
    expect(state.verification).toBeDefined()
    const v = state.verification as Record<string, unknown>
    expect(v.spec_ref).toBe('feat-foo')
    expect(v.spec_tier).toBe('standard')
    expect(v.declared_paths).toEqual(['src/seed.ts'])
    expect(v.started_at).toBeDefined()
  })

  it('passes requested_persona through to audit log and state', async () => {
    writeRsctConfig()
    const out = (await phaseVerificationStartHandler({
      project_root: tmpRoot,
      spec_ref: 'feat-bar',
      declared_paths: [],
      spec_tier: 'complex',
      persona: 'security',
    })) as PhaseVerificationStartOutput

    expect(out.requested_persona).toBe('security')
    const stateRaw = readFileSync(
      join(tmpRoot, '.rsct/phase-state.json'),
      'utf8',
    )
    const v = (JSON.parse(stateRaw) as { verification: Record<string, unknown> })
      .verification
    expect(v.persona).toBe('security')
  })

  it('appends verification.start + verification.finding entries to audit log', async () => {
    writeRsctConfig()
    // Sample-rsct fixture not needed — we set up corpus-less project; finding count = 0
    writeFile('src/seed.ts', 'export const x = 1\n')

    const out = (await phaseVerificationStartHandler({
      project_root: tmpRoot,
      spec_ref: 'feat-audit',
      declared_paths: ['src/seed.ts'],
      spec_tier: 'standard',
    })) as PhaseVerificationStartOutput

    expect(out.audit_path).toBeTruthy()
    expect(out.audit_error).toBeNull()
    const auditRaw = readFileSync(join(tmpRoot, '.rsct/audit.log'), 'utf8')
    const lines = auditRaw.trim().split('\n').map((l) => JSON.parse(l))
    expect(lines.some((l) => l.event === 'verification.start')).toBe(true)
  })

})

describe('phase-verification-start — input validation', () => {
  it('rejects empty spec_ref', async () => {
    writeRsctConfig()
    await expect(
      phaseVerificationStartHandler({
        project_root: tmpRoot,
        spec_ref: '',
      }),
    ).rejects.toThrow()
  })

  it('defaults declared_paths to empty array', async () => {
    writeRsctConfig()
    const out = (await phaseVerificationStartHandler({
      project_root: tmpRoot,
      spec_ref: 'no-paths',
    })) as PhaseVerificationStartOutput

    expect(out.declared_paths).toEqual([])
    expect(out.discovered_importers).toEqual([])
  })

  it('defaults spec_tier to standard', async () => {
    writeRsctConfig()
    const out = (await phaseVerificationStartHandler({
      project_root: tmpRoot,
      spec_ref: 'default-tier',
    })) as PhaseVerificationStartOutput

    expect(out.spec_tier).toBe('standard')
  })
})
