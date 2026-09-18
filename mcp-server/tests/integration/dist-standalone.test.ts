import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, copyFileSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const DIST = resolve(__dirname, '..', '..', 'dist', 'index.js')

const HANDSHAKE = [
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}',
  '{"jsonrpc":"2.0","method":"notifications/initialized"}',
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}',
  '',
].join('\n')

function runStandalone(): { stdout: string; stderr: string } {
  if (!existsSync(DIST)) {
    throw new Error(`dist/index.js not found at ${DIST} — run \`npm run build\` before this test`)
  }
  const dir = mkdtempSync(join(tmpdir(), 'rsct-standalone-'))
  try {
    const standalone = join(dir, 'index.js')
    copyFileSync(DIST, standalone)
    const r = spawnSync('node', [standalone], {
      input: HANDSHAKE,
      cwd: dir,
      env: { ...process.env, RSCT_PROJECT_ROOT: dir },
      encoding: 'utf8',
      timeout: 20_000,
    })
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const GRAMMARS = resolve(__dirname, '..', '..', 'grammars')

function runShipped(files: Record<string, string>): { stdout: string; stderr: string } {
  if (!existsSync(DIST)) {
    throw new Error(`dist/index.js not found at ${DIST} — run \`npm run build\` before this test`)
  }
  const dir = mkdtempSync(join(tmpdir(), 'rsct-shipped-'))
  try {
    const pkg = join(dir, 'pkg')
    mkdirSync(join(pkg, 'dist'), { recursive: true })
    copyFileSync(DIST, join(pkg, 'dist', 'index.js'))
    cpSync(GRAMMARS, join(pkg, 'grammars'), { recursive: true })
    const project = join(dir, 'project')
    mkdirSync(project, { recursive: true })
    spawnSync('git', ['init', '-q'], { cwd: project })
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(dirname(join(project, rel)), { recursive: true })
      writeFileSync(join(project, rel), content)
    }
    const call = {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'rsct_phase_review_start', arguments: { spec_ref: 'shipped' } },
    }
    const r = spawnSync('node', [join(pkg, 'dist', 'index.js')], {
      input: HANDSHAKE + JSON.stringify(call) + '\n',
      cwd: project,
      env: { ...process.env, RSCT_PROJECT_ROOT: project },
      encoding: 'utf8',
      timeout: 40_000,
    })
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('shipped dist loads every comment engine', () => {
  it('sweeps each supported language from the packaged grammars', () => {
    const { stdout, stderr } = runShipped({
      '.rsct.json': JSON.stringify({ rsct_version: '1.0.0', app: { name: 'a', org: 'o' }, sql_dialect: 'mysql' }),
      '.gitignore': '.rsct/\n',
      'a.ts': 'export const a = 1 // ts-comment\n',
      'b.tsx': 'export const b = <div /> // tsx-comment\n',
      'c.js': 'const c = 1 // js-comment\n',
      'D.java': 'class D { int x; // java-comment\n}\n',
      'e.py': 'x = 1  # py-comment\n',
      'f.php': '<?php\n$a = 1; // php-comment\n',
      'g.css': 'a { color: red; } /* css-comment */\n',
      'h.html': '<div><!-- html-comment --></div>\n',
      'i.sql': 'SELECT 1; # sql-comment\n',
    })
    const message = stdout
      .trim()
      .split('\n')
      .map((l) => {
        try {
          return JSON.parse(l)
        } catch {
          return null
        }
      })
      .find((m) => m && m.id === 3)
    expect(message, stderr).toBeTruthy()
    const payload = JSON.parse(message.result.content[0].text)
    const byPath = new Map<string, { kind: string; comments: Array<{ body: string }> }>(
      payload.comment_sweep.files.map((f: { path: string }) => [f.path, f]),
    )
    const expected: Record<string, string> = {
      'a.ts': 'ts-comment',
      'b.tsx': 'tsx-comment',
      'c.js': 'js-comment',
      'D.java': 'java-comment',
      'e.py': 'py-comment',
      'f.php': 'php-comment',
      'g.css': 'css-comment',
      'h.html': 'html-comment',
      'i.sql': 'sql-comment',
    }
    for (const [path, body] of Object.entries(expected)) {
      const file = byPath.get(path)
      expect(file?.kind, `${path}: ${JSON.stringify(file)}`).toBe('comments_present')
      expect(file?.comments.map((c) => c.body)).toEqual([body])
    }
  }, 60_000)
})

describe('dist is self-contained (runs with no node_modules)', () => {
  it('boots and lists tools from a temp dir outside the repo', () => {
    const { stdout, stderr } = runStandalone()
    expect(stderr, stderr).not.toMatch(/Cannot find package|ERR_MODULE_NOT_FOUND|Dynamic require of/)
    expect(stderr).toMatch(/rsct-mcp ready/)
    const tools = stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l)
        } catch {
          return null
        }
      })
      .find((m) => m && m.id === 2)?.result?.tools
    expect(Array.isArray(tools)).toBe(true)
    expect(tools.length).toBeGreaterThanOrEqual(29)
  }, 30_000)
})
