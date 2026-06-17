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
  phaseResearchStartHandler,
  type PhaseResearchStartOutput,
} from '../../src/tools/phase-research-start.js'
import {
  phaseResearchCompleteHandler,
  type PhaseResearchCompleteOutput,
} from '../../src/tools/phase-research-complete.js'
import type { DialogOptions, DialogResult } from '../../src/lib/os-dialog.js'

let tmpRoot: string

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'rsct-r-'))
  writeFileSync(
    join(tmpRoot, '.rsct.json'),
    JSON.stringify({
      rsct_version: '1.0.0',
      app: { name: 'test', org: 'test' },
    }),
    'utf8',
  )
})

afterEach(() => {
  if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true })
})

const FIXED_NOW = new Date('2026-06-07T18:00:00.000Z')
const VALID_TS = '2026-06-07T17:59:45.000Z'

function alwaysYes(): (opts: DialogOptions) => Promise<DialogResult> {
  return async () => ({ response: 'yes', channel: 'windows' })
}

describe('phase-research start + complete', () => {
  it('start writes phase=research and emits research.start audit', async () => {
    const r = (await phaseResearchStartHandler({
      project_root: tmpRoot,
      spec_ref: 'feat-research-pair',
    })) as PhaseResearchStartOutput
    expect(r.status).toBe('started')
    expect(r.phase).toBe('research')

    const state = JSON.parse(
      readFileSync(join(tmpRoot, '.rsct/phase-state.json'), 'utf8'),
    ) as Record<string, unknown>
    expect(state.phase).toBe('research')

    const audit = readFileSync(join(tmpRoot, '.rsct/audit.log'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    expect(audit.some((l) => l.event === 'research.start')).toBe(true)
  })

  it('complete clears phase + advances to spec when §C is yes', async () => {
    await phaseResearchStartHandler({
      project_root: tmpRoot,
      spec_ref: 'feat-research-pair',
    })

    const r = (await phaseResearchCompleteHandler(
      {
        project_root: tmpRoot,
        spec_ref: 'feat-research-pair',
        dev_approval: {
          timestamp: VALID_TS,
          action_scope: 'research_complete:spec_ref=feat-research-pair',
          reason: 'research phase complete; ready to advance to spec',
        },
      },
      { now: FIXED_NOW, promptFn: alwaysYes() },
    )) as PhaseResearchCompleteOutput
    expect(r.status).toBe('completed')
    expect(r.next_recommended_phase).toBe('spec')

    const state = JSON.parse(
      readFileSync(join(tmpRoot, '.rsct/phase-state.json'), 'utf8'),
    ) as Record<string, unknown>
    expect(state.phase).toBeUndefined()
    expect(state.spec_slug).toBe('feat-research-pair')
  })

  it('refuses start when a different phase is already active', async () => {
    mkdirSync(join(tmpRoot, '.rsct'), { recursive: true })
    writeFileSync(
      join(tmpRoot, '.rsct/phase-state.json'),
      JSON.stringify({ phase: 'spec', spec_slug: 'other' }),
      'utf8',
    )
    const r = (await phaseResearchStartHandler({
      project_root: tmpRoot,
      spec_ref: 'feat-new',
    })) as PhaseResearchStartOutput
    expect(r.status).toBe('phase_already_active')
    expect(r.existing_phase).toBe('spec')
  })

  it('rejects unknown keys (zod strict)', async () => {
    await expect(
      phaseResearchStartHandler({
        spec_ref: 'feat-foo',
        bogus: 'x',
      }),
    ).rejects.toThrow()
  })
})
