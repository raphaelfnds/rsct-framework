import { statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { canonicalPath } from './repo-anchor.js'

export type ProtectedVerdict = { block: false } | { block: true; reason: string }

const PASS: ProtectedVerdict = { block: false }
const GIT_FOLDER =
  "this write would change a file inside a git folder, where hooks, config and refs live; that is the developer's own edit"

export function bareName(name: string): string {
  const stream = name.indexOf(':')
  return (stream === -1 ? name : name.slice(0, stream)).replace(/[. ]+$/, '').toLowerCase()
}

export function pathComponents(path: string): string[] {
  return path
    .split(/[\\/]+/)
    .filter((c) => c.length > 0)
    .map((c, i) => (i === 0 && /^[A-Za-z]:$/.test(c) ? c.toLowerCase() : bareName(c)))
}

function exists(path: string, kind: 'file' | 'dir'): boolean {
  try {
    const st = statSync(path)
    return kind === 'file' ? st.isFile() : st.isDirectory()
  } catch {
    return false
  }
}

export function holdsGitRepository(dir: string): boolean {
  return exists(join(dir, 'HEAD'), 'file') && exists(join(dir, 'objects'), 'dir') && exists(join(dir, 'refs'), 'dir')
}

function judgeComponents(parts: string[]): ProtectedVerdict {
  const name = parts[parts.length - 1] ?? ''
  const parent = parts[parts.length - 2] ?? ''
  if (parts.includes('.git')) return { block: true, reason: GIT_FOLDER }
  if (name === '.gitconfig' || (name === 'gitconfig' && parent === 'etc') || ((name === 'config' || name === 'attributes') && parent === 'git')) {
    return { block: true, reason: "this write would change a git configuration file, which can make git run programs; that is the developer's own edit" }
  }
  if (parts.includes('.rsct')) {
    return { block: true, reason: "this write would change RSCT's own state, guard scripts or installed server under .rsct/; that is the developer's own edit, /rsct-setup or the installer" }
  }
  if (name.split('.')[0] === 'rsct-mcp' || parts.some((part, i) => part === 'node_modules' && parts[i + 1] === 'rsct-mcp')) {
    return { block: true, reason: "this write would change the rsct-mcp launcher or package that Claude Code starts as the RSCT server; that is the developer's own edit or the installer" }
  }
  return PASS
}

export function judgeProtectedPath(absolutePath: string): ProtectedVerdict {
  const canonical = canonicalPath(absolutePath)
  for (const spelling of [resolve(absolutePath), canonical]) {
    const verdict = judgeComponents(pathComponents(spelling))
    if (verdict.block) return verdict
  }
  let current = dirname(canonical)
  for (;;) {
    if (holdsGitRepository(current)) return { block: true, reason: GIT_FOLDER }
    const up = dirname(current)
    if (up === current) return PASS
    current = up
  }
}
