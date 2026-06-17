import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

import { parseSections, type MarkdownSection } from './markdown.js'

export interface ArchitectureFile {
  exists: boolean
  path: string | null
  sections: MarkdownSection[]
}

export interface ArchitectureModuleFile {
  name: string
  path: string
  sections: MarkdownSection[]
}

export interface ArchitectureModuleSet {
  directory_exists: boolean
  directory_path: string | null
  files: ArchitectureModuleFile[]
}

export function readArchitectureOverview(projectRoot: string): ArchitectureFile {
  const path = join(projectRoot, 'documentation', 'architecture.md')
  if (!existsSync(path)) return { exists: false, path: null, sections: [] }
  let body: string
  try {
    body = readFileSync(path, 'utf8')
  } catch {
    return { exists: true, path, sections: [] }
  }
  return { exists: true, path, sections: parseSections(body) }
}

export function readArchitectureModules(
  projectRoot: string,
  subdir: 'modules' | 'impact',
): ArchitectureModuleSet {
  const dir = join(projectRoot, 'documentation', subdir)
  if (!existsSync(dir)) {
    return { directory_exists: false, directory_path: null, files: [] }
  }
  let stat
  try {
    stat = statSync(dir)
  } catch {
    return { directory_exists: false, directory_path: null, files: [] }
  }
  if (!stat.isDirectory()) {
    return { directory_exists: false, directory_path: null, files: [] }
  }

  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return { directory_exists: true, directory_path: dir, files: [] }
  }

  const files: ArchitectureModuleFile[] = []
  for (const name of names) {
    if (!/\.md$/i.test(name)) continue
    if (/^README\.md$/i.test(name)) continue
    const full = join(dir, name)
    let body: string
    try {
      body = readFileSync(full, 'utf8')
    } catch {
      continue
    }
    files.push({
      name: name.replace(/\.md$/i, ''),
      path: relative(projectRoot, full).split('\\').join('/'),
      sections: parseSections(body),
    })
  }

  files.sort((a, b) => a.name.localeCompare(b.name))

  return {
    directory_exists: true,
    directory_path: relative(projectRoot, dir).split('\\').join('/'),
    files,
  }
}
