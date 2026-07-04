import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  checkEditScopeHandler,
  type CheckEditScopeOutput,
} from '../../src/tools/check-edit-scope.js'
import {
  globToRegex,
  matchesAnyGlob,
  readPhaseState,
} from '../../src/lib/phase-scope.js'
import { resolveProjectRoot } from '../../src/lib/project-root.js'

let tmpRoot: string

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'rsct-scope-'))
})

afterEach(() => {
  if (existsSync(tmpRoot)) {
    rmSync(tmpRoot, { recursive: true, force: true })
  }
})

describe('lib/phase-scope — globToRegex', () => {
  it('matches a literal path exactly', () => {
    const re = globToRegex('src/lib/util.ts')
    expect(re.test('src/lib/util.ts')).toBe(true)
    expect(re.test('src/lib/util.tsx')).toBe(false)
    expect(re.test('other/src/lib/util.ts')).toBe(false)
  })

  it('* does not cross slashes', () => {
    const re = globToRegex('src/*.ts')
    expect(re.test('src/util.ts')).toBe(true)
    expect(re.test('src/sub/util.ts')).toBe(false)
  })

  it('** crosses slashes (and consumes the slash after **)', () => {
    const re = globToRegex('src/**/util.ts')
    expect(re.test('src/util.ts')).toBe(true)
    expect(re.test('src/sub/util.ts')).toBe(true)
    expect(re.test('src/a/b/c/util.ts')).toBe(true)
    expect(re.test('src/other.ts')).toBe(false)
  })

  it('escapes regex metacharacters in the glob', () => {
    const re = globToRegex('src/file.with+special(chars).ts')
    expect(re.test('src/file.with+special(chars).ts')).toBe(true)
    expect(re.test('src/fileXwith+special(chars).ts')).toBe(false)
  })
})

describe('lib/phase-scope — matchesAnyGlob', () => {
  it('returns matched=true with the matched glob', () => {
    const r = matchesAnyGlob('mcp-server/src/lib/foo.ts', [
      'docs/**',
      'mcp-server/src/lib/**',
    ])
    expect(r.matched).toBe(true)
    expect(r.matched_glob).toBe('mcp-server/src/lib/**')
  })

  it('normalizes backslashes (Windows paths) before matching', () => {
    const r = matchesAnyGlob('mcp-server\\src\\lib\\foo.ts', [
      'mcp-server/src/lib/**',
    ])
    expect(r.matched).toBe(true)
  })

  it('returns matched=false when nothing matches', () => {
    const r = matchesAnyGlob('docs/readme.md', ['src/**'])
    expect(r.matched).toBe(false)
    expect(r.matched_glob).toBeUndefined()
  })

  // PH-1: relativization via prefix-strip against projectRoot (the reported
  // bug — an absolute file_path never matched a root-relative glob).
  it('matches an ABSOLUTE path under root against a root-relative glob', () => {
    const r = matchesAnyGlob('/proj/pom.xml', ['pom.xml'], '/proj')
    expect(r.matched).toBe(true)
    expect(r.matched_glob).toBe('pom.xml')
  })

  it('matches an absolute path against a nested relative glob', () => {
    const r = matchesAnyGlob('/proj/mcp-server/src/foo.ts', ['mcp-server/src/**'], '/proj')
    expect(r.matched).toBe(true)
  })

  it('does NOT match a subdir file against a root-level glob (no basename FP)', () => {
    const r = matchesAnyGlob('/proj/sub/pom.xml', ['pom.xml'], '/proj')
    expect(r.matched).toBe(false)
  })

  it('matches a subdir file against a **/-prefixed glob', () => {
    const r = matchesAnyGlob('/proj/sub/pom.xml', ['**/pom.xml'], '/proj')
    expect(r.matched).toBe(true)
  })

  it('folds Windows drive-letter case when relativizing', () => {
    const r = matchesAnyGlob('C:\\proj\\pom.xml', ['pom.xml'], 'c:/proj')
    expect(r.matched).toBe(true)
  })

  it('matches when file_path === projectRoot with a `*` glob (guard boundary)', () => {
    const r = matchesAnyGlob('/proj', ['*'], '/proj')
    expect(r.matched).toBe(true)
  })

  it('falls back to the absolute form when path is not under root (no regression)', () => {
    // glob loose enough to match the absolute form still matches
    const hit = matchesAnyGlob('/other/src/x.ts', ['**/src/**'], '/proj')
    expect(hit.matched).toBe(true)
    // a root-relative glob does NOT spuriously match an out-of-root path
    const miss = matchesAnyGlob('/other/pom.xml', ['pom.xml'], '/proj')
    expect(miss.matched).toBe(false)
  })

  it('preserves 2-arg behavior when projectRoot is omitted', () => {
    expect(matchesAnyGlob('/proj/pom.xml', ['pom.xml']).matched).toBe(false)
    expect(matchesAnyGlob('src/lib/foo.ts', ['src/**']).matched).toBe(true)
  })

  it('is case-sensitive in the glob body (only the drive letter folds)', () => {
    // documented limit — a lowercase glob does not match a differently-cased body
    expect(matchesAnyGlob('/proj/Pom.xml', ['pom.xml'], '/proj').matched).toBe(
      false,
    )
  })
})

describe('lib/phase-scope — readPhaseState', () => {
  it('returns exists=false when the file is missing', () => {
    const result = readPhaseState(tmpRoot)
    expect(result.exists).toBe(false)
    expect(result.state).toBeNull()
  })

  it('parses a well-formed phase state', () => {
    mkdirSync(join(tmpRoot, '.rsct'), { recursive: true })
    writeFileSync(
      join(tmpRoot, '.rsct', 'phase-state.json'),
      JSON.stringify({
        spec_slug: 'sample-spec',
        phase: 'F2.5.3',
        scope_globs: ['src/**'],
        started_at: '2026-06-03T20:00:00.000Z',
      }),
      'utf8',
    )
    const result = readPhaseState(tmpRoot)
    expect(result.exists).toBe(true)
    expect(result.state?.spec_slug).toBe('sample-spec')
    expect(result.state?.scope_globs).toEqual(['src/**'])
  })

  it('returns exists=true + state=null + parse_error for malformed JSON', () => {
    mkdirSync(join(tmpRoot, '.rsct'), { recursive: true })
    writeFileSync(join(tmpRoot, '.rsct', 'phase-state.json'), '{not json', 'utf8')
    const result = readPhaseState(tmpRoot)
    expect(result.exists).toBe(true)
    expect(result.state).toBeNull()
    expect(typeof result.parse_error).toBe('string')
  })
})

describe('rsct_check_edit_scope — handler', () => {
  it('returns status=unknown when phase state is absent', async () => {
    const out = (await checkEditScopeHandler({
      project_root: tmpRoot,
      file_path: 'src/lib/foo.ts',
    })) as CheckEditScopeOutput
    expect(out.phase_state_exists).toBe(false)
    expect(out.status).toBe('unknown')
    expect(out.scope_globs).toEqual([])
    expect(out.hints.some((h) => h.includes('M3'))).toBe(true)
  })

  it('returns status=in_scope with matched_glob when override matches', async () => {
    const out = (await checkEditScopeHandler({
      project_root: tmpRoot,
      file_path: 'mcp-server/src/lib/foo.ts',
      phase_state_override: {
        spec_slug: 'rsct-mcp-v2',
        phase: 'F2.5.3',
        scope_globs: ['mcp-server/src/lib/**', 'mcp-server/tests/**'],
      },
    })) as CheckEditScopeOutput
    expect(out.status).toBe('in_scope')
    expect(out.matched_glob).toBe('mcp-server/src/lib/**')
    expect(out.spec_slug).toBe('rsct-mcp-v2')
    expect(out.phase).toBe('F2.5.3')
  })

  it('returns status=out_of_scope when override does not match', async () => {
    const out = (await checkEditScopeHandler({
      project_root: tmpRoot,
      file_path: 'docs/readme.md',
      phase_state_override: { scope_globs: ['mcp-server/src/**'] },
    })) as CheckEditScopeOutput
    expect(out.status).toBe('out_of_scope')
    expect(out.matched_glob).toBeNull()
    expect(out.hints.some((h) => h.includes('OUTSIDE'))).toBe(true)
  })

  it('reads the on-disk phase-state.json and matches scope', async () => {
    mkdirSync(join(tmpRoot, '.rsct'), { recursive: true })
    writeFileSync(
      join(tmpRoot, '.rsct', 'phase-state.json'),
      JSON.stringify({
        spec_slug: 'sample',
        phase: 'F1',
        scope_globs: ['src/feature/**'],
      }),
      'utf8',
    )
    const out = (await checkEditScopeHandler({
      project_root: tmpRoot,
      file_path: 'src/feature/index.ts',
    })) as CheckEditScopeOutput
    expect(out.phase_state_exists).toBe(true)
    expect(out.status).toBe('in_scope')
    expect(out.matched_glob).toBe('src/feature/**')
  })

  it('surfaces parse_error when on-disk file is malformed', async () => {
    mkdirSync(join(tmpRoot, '.rsct'), { recursive: true })
    writeFileSync(
      join(tmpRoot, '.rsct', 'phase-state.json'),
      'not json at all',
      'utf8',
    )
    const out = (await checkEditScopeHandler({
      project_root: tmpRoot,
      file_path: 'anything.ts',
    })) as CheckEditScopeOutput
    expect(out.phase_state_exists).toBe(true)
    expect(out.status).toBe('unknown')
    expect(typeof out.phase_state_parse_error).toBe('string')
  })

  it('returns status=unknown when scope_globs is empty', async () => {
    const out = (await checkEditScopeHandler({
      project_root: tmpRoot,
      file_path: 'anything.ts',
      phase_state_override: { scope_globs: [] },
    })) as CheckEditScopeOutput
    expect(out.status).toBe('unknown')
    expect(out.hints.some((h) => h.includes('empty'))).toBe(true)
  })

  it('rejects missing file_path (zod required)', async () => {
    await expect(checkEditScopeHandler({ project_root: tmpRoot })).rejects.toThrow()
  })

  it('rejects unknown keys (zod strict)', async () => {
    await expect(
      checkEditScopeHandler({
        project_root: tmpRoot,
        file_path: 'a.ts',
        bogus: 'x',
      }),
    ).rejects.toThrow()
  })

  it('matches an ABSOLUTE file_path against a root-relative glob (PH-1, end-to-end)', async () => {
    // Build the abs path from the SAME root the handler resolves, so this is
    // robust to any symlink/realpath normalization (macOS /var→/private/var).
    const root = resolveProjectRoot(tmpRoot).root
    const abs = join(root, 'pom.xml')
    const out = (await checkEditScopeHandler({
      project_root: tmpRoot,
      file_path: abs,
      phase_state_override: { scope_globs: ['pom.xml'] },
    })) as CheckEditScopeOutput
    expect(out.status).toBe('in_scope')
    expect(out.matched_glob).toBe('pom.xml')
  })
})

describe('lib/phase-scope — writePhaseState + file lock (CAP-3)', () => {
  // tmpRoot from the outer beforeEach is reused — no fresh setup needed.
  // The outer afterEach cleans up the tmpdir between cases.

  it('writes the phase-state.json with pretty-printed JSON + trailing newline', async () => {
    const { writePhaseState } = await import(
      '../../src/lib/phase-scope.js'
    )
    const result = writePhaseState(tmpRoot, {
      phase: 'spec',
      spec_slug: 'feat-foo',
    })
    expect(result.ok).toBe(true)
    const path = join(tmpRoot, '.rsct/phase-state.json')
    expect(existsSync(path)).toBe(true)
    const content = readFileSync(path, 'utf8')
    expect(content.endsWith('\n')).toBe(true)
    expect(content).toContain('"phase": "spec"')
  })

  it('removes the .rsct/phase-state.lock file after a successful write', async () => {
    const { writePhaseState } = await import(
      '../../src/lib/phase-scope.js'
    )
    const result = writePhaseState(tmpRoot, { phase: 'spec' })
    expect(result.ok).toBe(true)
    const lockPath = join(tmpRoot, '.rsct/phase-state.lock')
    expect(existsSync(lockPath)).toBe(false)
  })

  it('returns reason=locked when another writer holds a recent lock', async () => {
    const { writePhaseState } = await import(
      '../../src/lib/phase-scope.js'
    )
    mkdirSync(join(tmpRoot, '.rsct'), { recursive: true })
    writeFileSync(
      join(tmpRoot, '.rsct/phase-state.lock'),
      JSON.stringify({
        session_id: 'peer-session-1234',
        locked_at: new Date().toISOString(),
      }),
      'utf8',
    )
    const result = writePhaseState(tmpRoot, { phase: 'spec' })
    expect(result.ok).toBe(false)
    if (!result.ok && result.reason === 'locked') {
      expect(result.held_by_session).toBe('peer-session-1234')
      expect(result.lock_age_ms).toBeGreaterThanOrEqual(0)
      expect(result.lock_age_ms).toBeLessThan(30000)
    } else {
      throw new Error(
        `expected reason='locked', got ${JSON.stringify(result)}`,
      )
    }
  })

  it('overwrites a stale lock (>30s old) and proceeds', async () => {
    const { writePhaseState } = await import(
      '../../src/lib/phase-scope.js'
    )
    mkdirSync(join(tmpRoot, '.rsct'), { recursive: true })
    const staleAge = 31000
    writeFileSync(
      join(tmpRoot, '.rsct/phase-state.lock'),
      JSON.stringify({
        session_id: 'dead-session',
        locked_at: new Date(Date.now() - staleAge).toISOString(),
      }),
      'utf8',
    )
    const result = writePhaseState(tmpRoot, { phase: 'spec' })
    expect(result.ok).toBe(true)
    expect(existsSync(join(tmpRoot, '.rsct/phase-state.json'))).toBe(true)
    // Lock cleared after the successful write
    expect(existsSync(join(tmpRoot, '.rsct/phase-state.lock'))).toBe(false)
  })

  it('treats a corrupt lock file as stale and overwrites', async () => {
    const { writePhaseState } = await import(
      '../../src/lib/phase-scope.js'
    )
    mkdirSync(join(tmpRoot, '.rsct'), { recursive: true })
    writeFileSync(
      join(tmpRoot, '.rsct/phase-state.lock'),
      '{not valid json',
      'utf8',
    )
    const result = writePhaseState(tmpRoot, { phase: 'spec' })
    expect(result.ok).toBe(true)
  })

  it('writes are sequential (second non-stale lock blocks until first releases)', async () => {
    const { writePhaseState } = await import(
      '../../src/lib/phase-scope.js'
    )
    // First write — should succeed and release the lock.
    const r1 = writePhaseState(tmpRoot, { phase: 'spec' })
    expect(r1.ok).toBe(true)
    // Second write — lock is gone (released by first), so this also succeeds.
    const r2 = writePhaseState(tmpRoot, { phase: 'code' })
    expect(r2.ok).toBe(true)
    const content = readFileSync(
      join(tmpRoot, '.rsct/phase-state.json'),
      'utf8',
    )
    expect(content).toContain('"phase": "code"')
  })
})
