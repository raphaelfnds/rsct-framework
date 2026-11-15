export interface AppliesTo {
  globs: string[]
  rejected: string[]
  unbound: string[]
}

export type AppliesToLine = { binds: true; globs: string[]; rejected: string[] } | { binds: false; value: string }

const APPLIES_TO_LINE = /^(?:-\s+)?\*\*applies\s+to(?::\*\*|\*\*\s*:)(.*)$/i

export const GLOB_MAX_LENGTH = 256

export const STARS_PER_SEGMENT_MAX = 4

export const GLOBS_PER_ENTRY_MAX = 64

const HIDDEN = /[\p{Cc}\p{Cf}]/u

function checkGlob(item: string): { glob: string } | { reason: string } {
  let glob = item.replace(/\\/g, '/')
  while (glob.startsWith('./')) glob = glob.slice(2)
  if (glob === '') return { reason: 'empty' }
  if (HIDDEN.test(glob)) return { reason: 'a control or invisible character' }
  if (glob.startsWith('/') || /^[A-Za-z]:/.test(glob)) return { reason: 'an absolute path' }
  if (glob.length > GLOB_MAX_LENGTH) return { reason: `longer than ${GLOB_MAX_LENGTH} characters` }
  const segments: string[] = []
  for (const segment of glob.split('/')) {
    if (segment === '..') return { reason: 'leaves the project folder' }
    if (segment === '**' && segments[segments.length - 1] === '**') continue
    if (segment !== '**' && segment.split('*').length - 1 > STARS_PER_SEGMENT_MAX) {
      return { reason: `more than ${STARS_PER_SEGMENT_MAX} '*' in one segment` }
    }
    segments.push(segment)
  }
  return { glob: segments.join('/') }
}

export function readAppliesToLine(line: string): AppliesToLine | null {
  const match = APPLIES_TO_LINE.exec(line.trim())
  if (!match) return null
  const value = (match[1] ?? '').trim()
  const items = value.split(',').map((item) => item.replace(/`/g, '').trim())
  if (value === '' || items.some((item) => item === '' || /\s/.test(item))) return { binds: false, value }
  const globs: string[] = []
  const rejected: string[] = []
  for (const item of items) {
    const checked = checkGlob(item)
    if ('glob' in checked) globs.push(checked.glob)
    else rejected.push(`${item} (${checked.reason})`)
  }
  return { binds: true, globs, rejected }
}

export function isBindingAppliesToLine(line: string): boolean {
  return readAppliesToLine(line)?.binds === true
}

export function collectAppliesTo(section: string): AppliesTo | undefined {
  let found = false
  const out: AppliesTo = { globs: [], rejected: [], unbound: [] }
  for (const line of section.split('\n')) {
    const read = readAppliesToLine(line)
    if (read === null) continue
    found = true
    if (!read.binds) {
      out.unbound.push(read.value)
      continue
    }
    for (const glob of read.globs) {
      if (out.globs.includes(glob)) continue
      if (out.globs.length >= GLOBS_PER_ENTRY_MAX) out.rejected.push(`${glob} (more than ${GLOBS_PER_ENTRY_MAX} globs on one entry)`)
      else out.globs.push(glob)
    }
    out.rejected.push(...read.rejected)
  }
  return found ? out : undefined
}
