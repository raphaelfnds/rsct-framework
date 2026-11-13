import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { canonicalPath } from './repo-anchor.js'

export type ProtectedVerdict = { block: false } | { block: true; reason: string }

const PASS: ProtectedVerdict = { block: false }
const GIT_FOLDER =
  "this write would change a file inside a git folder, where hooks, config and refs live; that is the developer's own edit"

export function bareName(name: string): string {
  return name.replace(/::\$(data|index_allocation)$/i, '').replace(/[. ]+$/, '').toLowerCase()
}

export function pathComponents(path: string): string[] {
  return path.split(/[\\/]+/).filter((c) => c.length > 0).map(bareName)
}

function exists(path: string, kind: 'file' | 'dir'): boolean {
  try {
    const st = statSync(path)
    return kind === 'file' ? st.isFile() : st.isDirectory()
  } catch {
    return false
  }
}

function holdsGitRepository(dir: string): boolean {
  return exists(join(dir, 'HEAD'), 'file') && exists(join(dir, 'objects'), 'dir') && exists(join(dir, 'refs'), 'dir')
}

export function judgeProtectedPath(absolutePath: string, home: string = homedir()): ProtectedVerdict {
  const canonical = canonicalPath(absolutePath)
  const parts = pathComponents(canonical)
  const name = parts[parts.length - 1] ?? ''
  const parent = parts[parts.length - 2] ?? ''
  if (parts.includes('.git')) return { block: true, reason: GIT_FOLDER }
  if (name === '.gitconfig' || (name === 'gitconfig' && parent === 'etc') || ((name === 'config' || name === 'attributes') && parent === 'git')) {
    return { block: true, reason: "this write would change a git configuration file, which can make git run programs; that is the developer's own edit" }
  }
  const rsctAt = parts.indexOf('.rsct')
  if (rsctAt !== -1 && parts.slice(0, rsctAt + 1).join('/') !== pathComponents(canonicalPath(join(home, '.rsct'))).join('/')) {
    return { block: true, reason: "this write would change RSCT's own state or guard scripts under .rsct/; that is the developer's own edit, or /rsct-setup" }
  }
  let current = dirname(canonical)
  for (;;) {
    if (holdsGitRepository(current)) return { block: true, reason: GIT_FOLDER }
    const up = dirname(current)
    if (up === current) return PASS
    current = up
  }
}
