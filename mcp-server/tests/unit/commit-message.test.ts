import { describe, it, expect } from 'vitest'
import {
  checkCommitMessage,
  countNonEmptyLines,
  resolveCommitMessageMaxLines,
  COMMIT_MESSAGE_MAX_LINES_DEFAULT,
} from '../../src/lib/commit-message.js'
import type { RsctConfig } from '../../src/lib/project-root.js'

const cfg = (commit_message_max_lines?: number): RsctConfig =>
  commit_message_max_lines === undefined ? {} : { commit_message_max_lines }

const lines = (n: number): string =>
  Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n')

describe('countNonEmptyLines', () => {
  it('counts only lines with content', () => {
    expect(countNonEmptyLines('a\nb\nc')).toBe(3)
  })

  it('does not count blank or whitespace-only lines', () => {
    // Paragraph spacing is layout, not content — penalizing it would push
    // authors toward unreadable walls of text to stay under the cap.
    expect(countNonEmptyLines('subject\n\nbody\n\n   \nmore')).toBe(3)
  })

  it('counts a CRLF message the same as an LF one', () => {
    expect(countNonEmptyLines('a\r\nb\r\n\r\nc')).toBe(3)
  })

  it('handles an empty message and a trailing newline', () => {
    expect(countNonEmptyLines('')).toBe(0)
    expect(countNonEmptyLines('only\n')).toBe(1)
  })
})

describe('resolveCommitMessageMaxLines', () => {
  it('defaults to 15 when unset, null config, or non-finite', () => {
    expect(resolveCommitMessageMaxLines(null)).toBe(COMMIT_MESSAGE_MAX_LINES_DEFAULT)
    expect(resolveCommitMessageMaxLines(undefined)).toBe(15)
    expect(resolveCommitMessageMaxLines(cfg())).toBe(15)
    expect(resolveCommitMessageMaxLines(cfg(Number.NaN))).toBe(15)
    expect(resolveCommitMessageMaxLines(cfg(Number.POSITIVE_INFINITY))).toBe(15)
  })

  it('honors a configured limit', () => {
    expect(resolveCommitMessageMaxLines(cfg(30))).toBe(30)
  })

  it('clamps instead of rejecting — an out-of-range value must not null the config', () => {
    expect(resolveCommitMessageMaxLines(cfg(0))).toBe(1)
    expect(resolveCommitMessageMaxLines(cfg(-5))).toBe(1)
    expect(resolveCommitMessageMaxLines(cfg(10_000))).toBe(500)
    expect(resolveCommitMessageMaxLines(cfg(12.9))).toBe(12)
  })
})

describe('checkCommitMessage', () => {
  it('accepts exactly the limit', () => {
    const r = checkCommitMessage(lines(15), null)
    expect(r.ok).toBe(true)
    expect(r.lines).toBe(15)
    expect(r.reason).toBeNull()
  })

  it('rejects one line over', () => {
    const r = checkCommitMessage(lines(16), null)
    expect(r.ok).toBe(false)
    expect(r.lines).toBe(16)
    expect(r.limit).toBe(15)
  })

  it('the reason carries the whole rule, since the rules/ prose never reaches an existing install', () => {
    const r = checkCommitMessage(lines(20), null)
    expect(r.reason).toContain('20 non-empty lines')
    expect(r.reason).toContain('limit is 15')
    expect(r.reason).toContain('Blank lines are not counted')
    expect(r.reason).toContain('commit_message_max_lines')
  })

  it('blank lines do not push a message over', () => {
    const padded = lines(15).split('\n').join('\n\n')
    expect(checkCommitMessage(padded, null).ok).toBe(true)
  })

  it('honors a raised limit from config', () => {
    expect(checkCommitMessage(lines(20), cfg(25)).ok).toBe(true)
    expect(checkCommitMessage(lines(26), cfg(25)).ok).toBe(false)
  })
})
