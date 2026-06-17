import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  tutorStepHandler,
  type TutorStepOutput,
} from '../../src/tools/tutor-step.js'

let tmpRoot: string

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'rsct-tutor-'))
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

describe('rsct_tutor_step — step counting', () => {
  it('returns step_number=1 for the first step of a spec_ref', async () => {
    const r = (await tutorStepHandler({
      project_root: tmpRoot,
      spec_ref: 'session-A',
      step_kind: 'propose',
      step_description: 'open the file at src/lib/foo.ts and read its contents',
    })) as TutorStepOutput
    expect(r.step_number).toBe(1)
    expect(r.is_complete).toBe(false)
  })

  it('increments step_number across multiple calls of the same spec_ref', async () => {
    const a = (await tutorStepHandler({
      project_root: tmpRoot,
      spec_ref: 'session-B',
      step_kind: 'propose',
      step_description: 'first step — propose to read the architecture file',
    })) as TutorStepOutput
    const b = (await tutorStepHandler({
      project_root: tmpRoot,
      spec_ref: 'session-B',
      step_kind: 'execute',
      step_description: 'second step — read the architecture file',
      result: 'file is 80 lines; covers stack + flow + dirs',
    })) as TutorStepOutput
    expect(a.step_number).toBe(1)
    expect(b.step_number).toBe(2)
  })

  it('counts steps independently per spec_ref', async () => {
    await tutorStepHandler({
      project_root: tmpRoot,
      spec_ref: 'spec-A',
      step_kind: 'propose',
      step_description: 'first step of spec-A on the same project',
    })
    const r = (await tutorStepHandler({
      project_root: tmpRoot,
      spec_ref: 'spec-B',
      step_kind: 'propose',
      step_description: 'first step of spec-B on the same project',
    })) as TutorStepOutput
    expect(r.step_number).toBe(1)
  })
})

describe('rsct_tutor_step — step kinds', () => {
  it('is_complete=true when step_kind="complete"', async () => {
    const r = (await tutorStepHandler({
      project_root: tmpRoot,
      spec_ref: 'session-C',
      step_kind: 'complete',
      step_description: 'session complete — all 4 sub-tasks landed',
    })) as TutorStepOutput
    expect(r.is_complete).toBe(true)
    expect(r.hints.some((h) => h.includes('complete'))).toBe(true)
  })

  it('accepts batch_commands when step_kind="read-batch"', async () => {
    const r = (await tutorStepHandler({
      project_root: tmpRoot,
      spec_ref: 'session-D',
      step_kind: 'read-batch',
      step_description:
        'check server load and nginx + redis status all at once',
      batch_commands: ['df -h', 'free -m', 'systemctl status nginx'],
    })) as TutorStepOutput
    expect(r.step_kind).toBe('read-batch')
    const lines = readFileSync(join(tmpRoot, '.rsct/audit.log'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    const last = lines[lines.length - 1]
    expect(last.batch_commands).toEqual([
      'df -h',
      'free -m',
      'systemctl status nginx',
    ])
  })

  it('warns when batch_commands has more than 5 entries', async () => {
    const r = (await tutorStepHandler({
      project_root: tmpRoot,
      spec_ref: 'session-E',
      step_kind: 'read-batch',
      step_description: 'very broad investigative scan of the host',
      batch_commands: ['df -h', 'free -m', 'lscpu', 'lspci', 'lsblk', 'lsmod'],
    })) as TutorStepOutput
    expect(r.hints.some((h) => h.includes('generous'))).toBe(true)
  })
})

describe('rsct_tutor_step — resume_block', () => {
  it('includes the spec_ref and last description', async () => {
    const r = (await tutorStepHandler({
      project_root: tmpRoot,
      spec_ref: 'session-F',
      step_kind: 'observe',
      step_description: 'noted that nginx is using 89% CPU under steady load',
      result: 'nginx pid 1234 at 89% CPU, no obvious blocking workers',
    })) as TutorStepOutput
    expect(r.resume_block).toContain('session-F')
    expect(r.resume_block).toContain('nginx is using 89%')
  })

  it('truncates long results to 200 chars + ellipsis', async () => {
    const longResult = 'x'.repeat(300)
    const r = (await tutorStepHandler({
      project_root: tmpRoot,
      spec_ref: 'session-G',
      step_kind: 'execute',
      step_description: 'ran the command and captured output',
      result: longResult,
    })) as TutorStepOutput
    expect(r.resume_block).toContain('…')
    expect(r.resume_block.length).toBeLessThan(longResult.length + 200)
  })
})

describe('rsct_tutor_step — audit', () => {
  it('appends tutor.step event with the canonical fields', async () => {
    await tutorStepHandler({
      project_root: tmpRoot,
      spec_ref: 'session-H',
      step_kind: 'propose',
      step_description:
        'propose to check the queue lag on the redis worker before mutating',
    })
    const audit = readFileSync(join(tmpRoot, '.rsct/audit.log'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    const last = audit[audit.length - 1]
    expect(last.event).toBe('tutor.step')
    expect(last.spec_ref).toBe('session-H')
    expect(last.step_kind).toBe('propose')
    expect(last.step_number).toBe(1)
  })
})

describe('rsct_tutor_step — input validation', () => {
  it('rejects spec_ref < 3 chars', async () => {
    await expect(
      tutorStepHandler({
        project_root: tmpRoot,
        spec_ref: 'aa',
        step_kind: 'propose',
        step_description: 'a valid description that is long enough',
      }),
    ).rejects.toThrow()
  })

  it('rejects step_description < 10 chars', async () => {
    await expect(
      tutorStepHandler({
        project_root: tmpRoot,
        spec_ref: 'session-V',
        step_kind: 'propose',
        step_description: 'short',
      }),
    ).rejects.toThrow()
  })

  it('rejects unknown step_kind', async () => {
    await expect(
      tutorStepHandler({
        project_root: tmpRoot,
        spec_ref: 'session-V',
        step_kind: 'whatever',
        step_description: 'a step with a bogus kind value here',
      }),
    ).rejects.toThrow()
  })

  it('rejects unknown keys (zod strict)', async () => {
    await expect(
      tutorStepHandler({
        project_root: tmpRoot,
        spec_ref: 'session-V',
        step_kind: 'propose',
        step_description: 'a valid step description here for the bogus test',
        bogus: 'x',
      }),
    ).rejects.toThrow()
  })
})
