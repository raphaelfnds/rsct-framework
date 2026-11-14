import { createHash } from 'node:crypto'

const SHIPPED_PLACEHOLDER_SHA256: ReadonlySet<string> = new Set([
  'eb53d44c4e2bd0f1ce079ac487747d58275bb7b89d8fa54ffc858db211d8bd42',
  '0a66a2c5754c1b5eead299804a643f5504e7c74b7fc235255d6f68a29aa1cf61',
  '8b857e6c0e099df5ff5ee9dfb3c7d904c7cac5951d47b43dae119006cc32bb8f',
])

const SHIPPED_ID_LINES: ReadonlySet<string> = new Set(['Numbering: AD-001, AD-002, ... sequential, append-only.'])

const ENTRY_NUMBER = /^(#{2,3}\s+(?:#|ADR-|AD-))\d+/

export function isShippedPlaceholder(heading: string, bodyLines: readonly string[]): boolean {
  const lines = [heading.replace(ENTRY_NUMBER, '$1N'), ...bodyLines].map((line) => line.replace(/\r/g, ''))
  while (lines.length > 1 && lines[lines.length - 1]?.trim() === '') lines.pop()
  return SHIPPED_PLACEHOLDER_SHA256.has(createHash('sha256').update(lines.join('\n')).digest('hex'))
}

export function withoutShippedIdLines(lines: readonly string[]): string {
  return lines.filter((line) => !SHIPPED_ID_LINES.has(line.replace(/\r$/, ''))).join('\n')
}
