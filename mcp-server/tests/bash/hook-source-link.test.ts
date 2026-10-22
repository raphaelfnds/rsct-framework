import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, delimiter, basename, dirname } from 'node:path'
import { bashAvailable, repoRoot } from './lib/bash-lint.js'
import { runBlock } from './lib/block-harness.js'

const BASH = bashAvailable()
const ROOT = repoRoot(__dirname)
const ANCHOR = 'CHECKPOINT: Phase 4.V.a locating the hook scripts'
const SCRIPT = 'dist/scripts/sanitize-permissions.js'

const sandboxes: string[] = []
function newSandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rsct-hooksrc-'))
  sandboxes.push(dir)
  return dir
}
afterEach(() => {
  while (sandboxes.length) {
    const d = sandboxes.pop()!
    try { rmSync(d, { recursive: true, force: true }) } catch {}
  }
})

const STUB_NPM = '#!/bin/sh\nif [ "$1 $2" = "root -g" ]; then printf "%s\\n" "$STUB_NPM_ROOT"; exit 0; fi\nexit 1\n'

function companionFolder(withScripts: boolean): string {
  const dir = newSandbox()
  mkdirSync(join(dir, 'dist', 'scripts'), { recursive: true })
  if (withScripts) writeFileSync(join(dir, SCRIPT), '#!/usr/bin/env node\n')
  writeFileSync(join(dir, 'package.json'), '{ "name": "rsct-mcp", "version": "9.9.9" }\n')
  return dir
}

function locate(entry: (globalRoot: string) => void, env: Record<string, string> = {}) {
  const globalRoot = join(newSandbox(), 'node_modules')
  mkdirSync(globalRoot)
  entry(globalRoot)
  const stub = newSandbox()
  writeFileSync(join(stub, 'npm'), STUB_NPM)
  chmodSync(join(stub, 'npm'), 0o755)
  const inherited = Object.entries(process.env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? ''
  const r = runBlock(ROOT, {
    promptBasename: '01-setup.md',
    anchor: ANCHOR,
    preamble: `trap 'printf "\\nSANITIZER_SRC=[%s]\\n" "$SANITIZER_SRC"' EXIT`,
    env: { PATH: `${stub}${delimiter}${inherited}`, STUB_NPM_ROOT: globalRoot, ...env },
  })
  sandboxes.push(r.dir)
  const found = r.out.match(/SANITIZER_SRC=\[([^\]]*)\]/)
  expect(found, r.out).not.toBeNull()
  return { out: r.out, src: found![1]!, sandbox: basename(dirname(globalRoot)) }
}

describe.skipIf(!BASH)('01-setup 4.V.a takes the hook scripts only through a link', () => {
  it('accepts the link the installer makes (or a contributor makes to a clone)', () => {
    const target = companionFolder(true)
    const { out, src, sandbox } = locate((root) => symlinkSync(target, join(root, 'rsct-mcp'), 'junction'))
    expect(src, out).toMatch(/\/node_modules\/rsct-mcp\/dist\/scripts\/sanitize-permissions\.js$/)
    expect(src, 'the path must come from the stub npm, not the real one').toContain(sandbox)
    expect(out).not.toMatch(/WARN/)
  })

  it('refuses a plain folder under that name, and says how to fix it', () => {
    const { out, src } = locate((root) => {
      mkdirSync(join(root, 'rsct-mcp', 'dist', 'scripts'), { recursive: true })
      writeFileSync(join(root, 'rsct-mcp', SCRIPT), '#!/usr/bin/env node\n')
    })
    expect(src, out).toBe('')
    expect(out, out).toMatch(/is a plain folder, not the link the framework installer creates/)
    expect(out, out).toMatch(/bash scripts\/install\.sh/)
  })

  it('ignores RSCT_FRAMEWORK_SOURCE', () => {
    const clone = newSandbox()
    mkdirSync(join(clone, 'mcp-server', 'dist', 'scripts'), { recursive: true })
    writeFileSync(join(clone, 'mcp-server', SCRIPT), '#!/usr/bin/env node\n')
    const { out, src } = locate(() => {}, { RSCT_FRAMEWORK_SOURCE: clone })
    expect(src, out).toBe('')
    expect(out, out).toMatch(/rsct-mcp hook scripts not found/)
  })

  it('a link to a folder without the scripts is not found, not accepted', () => {
    const target = companionFolder(false)
    const { out, src } = locate((root) => symlinkSync(target, join(root, 'rsct-mcp'), 'junction'))
    expect(src, out).toBe('')
    expect(out, out).toMatch(/rsct-mcp hook scripts not found/)
  })
})
