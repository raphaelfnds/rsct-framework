import { describe, it, expect } from 'vitest'
import { getInstallDriftNotice } from '../../src/lib/version-drift.js'

describe('getInstallDriftNotice', () => {
  it('fires when the binary is strictly newer than the project version', () => {
    const { hint } = getInstallDriftNotice('2.0.0', '2.1.0')
    expect(hint).not.toBeNull()
    expect(hint).toContain('v2.0.0')
    expect(hint).toContain('v2.1.0')
    expect(hint).toContain('Re-run /rsct-setup')
    expect(hint).toContain('(suggestion only)')
  })

  it('is silent when versions are equal', () => {
    expect(getInstallDriftNotice('2.1.0', '2.1.0').hint).toBeNull()
  })

  it('is silent when the project is NEWER than the binary (reverse case — out of scope)', () => {
    expect(getInstallDriftNotice('2.2.0', '2.1.0').hint).toBeNull()
  })

  it('is silent on null / undefined / empty project version', () => {
    expect(getInstallDriftNotice(null, '2.1.0').hint).toBeNull()
    expect(getInstallDriftNotice(undefined, '2.1.0').hint).toBeNull()
    expect(getInstallDriftNotice('', '2.1.0').hint).toBeNull()
  })

  it('is silent on an unparseable project version (fail-safe via isNewer)', () => {
    for (const bad of ['garbage', '1.0', '2.x', 'latest', 'v1']) {
      expect(getInstallDriftNotice(bad, '2.1.0').hint).toBeNull()
    }
  })

  it('strips a hand-edited leading "v" in the text (no "vv")', () => {
    const { hint } = getInstallDriftNotice('v2.0.0', 'v2.1.0')
    expect(hint).not.toBeNull()
    expect(hint).toContain('v2.0.0')
    expect(hint).toContain('v2.1.0')
    expect(hint).not.toContain('vv')
  })

  it('handles a minor/patch drift (2.1.0 -> 2.1.1)', () => {
    expect(getInstallDriftNotice('2.1.0', '2.1.1').hint).toContain('v2.1.1')
  })
})
