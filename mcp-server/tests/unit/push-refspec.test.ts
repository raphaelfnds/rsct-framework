import { describe, it, expect } from 'vitest'
import {
  parsePushRefspec,
  pushRefspecRejectReason,
  stripRefsPrefix,
} from '../../src/lib/push-refspec.js'

/**
 * #62 B5. Every shape below was measured against a real bare remote on git
 * 2.45.1.windows.1 BEFORE this module existed: each one lands on the remote's
 * `main` while `isProtectedBranch` — an exact string compare — returns false.
 */
describe('lib/push-refspec — parsePushRefspec', () => {
  const dest = (s: string): string => {
    const r = parsePushRefspec(s)
    if (!r.ok) throw new Error(`expected ok for ${s}, got ${r.reason}`)
    return r.destination
  }

  // Breaks on: dropping the `+` strip. Measured: `git push origin '+main'` on a
  // DIVERGED branch is rc=0 and FORCE-UPDATES protected main, while the plain
  // `git push origin main` is refused rc=1 non-fast-forward. And
  // `git check-ref-format --branch '+main'` returns 0, so git's own validator
  // offers no help here.
  it('strips the force marker and reports the push as forced', () => {
    const r = parsePushRefspec('+main')
    expect(r.ok && r.destination).toBe('main')
    expect(r.ok && r.forced).toBe(true)
    expect(parsePushRefspec('main').ok && parsePushRefspec('main')).toMatchObject({ forced: false })
  })

  // Breaks on: splitting on the FIRST colon. Measured twice: git reports src
  // `main:refs/heads/zz` for `main:refs/heads/zz:qq`, and parses dst
  // `refs/heads/main` out of `HEAD:a:refs/heads/main`. A first-colon split reads
  // that dst as `a:refs/heads/main` and misses the protected branch entirely.
  it('splits on the LAST colon, as git does', () => {
    expect(dest('HEAD:main')).toBe('main')
    expect(dest('HEAD:a:refs/heads/main')).toBe('refs/heads/main')
    expect(dest('feat/x:feat/renamed')).toBe('feat/renamed')
  })

  // Breaks on: dropping the refs/heads/ and heads/ stripping. The protected list
  // holds BARE names, so without this `refs/heads/main` never matches `main` —
  // and the gate silently becomes a no-op for the qualified forms.
  it('offers the prefix-stripped forms as comparison candidates', () => {
    for (const spec of ['refs/heads/main', 'heads/main']) {
      const r = parsePushRefspec(spec)
      expect(r.ok && r.candidates, spec).toContain('main')
    }
    expect(stripRefsPrefix('refs/heads/a/b')).toBe('a/b')
    expect(stripRefsPrefix('heads/a/b')).toBe('a/b')
    expect(stripRefsPrefix('refs/tags/v1')).toBe('refs/tags/v1') // not a branch — left alone
  })

  // Breaks on: removing the empty-destination reject. A bare ':' is git's
  // "matching" refspec: it pushes every matching ref, protected ones included,
  // and an empty destination matches nothing in the list so the gate passes.
  it('refuses the bare-colon matching refspec', () => {
    const r = parsePushRefspec(':')
    expect(r.ok).toBe(false)
    expect(!r.ok && r.reason).toBe('empty_destination')
  })

  // Breaks on: removing the '*' reject. Measured: `git push origin
  // '+refs/heads/main*:refs/heads/main*'` is rc=0 and force-updates protected
  // main while the plain push of the same state is refused, and `rev-parse
  // --symbolic-full-name 'refs/heads/main*'` returns rc=0 echoing the glob, so
  // canonicalization is a no-op on it. '*' is the ONLY legal refspec glob — '?'
  // and '[m]' are `fatal: invalid refspec` — so one character closes the class.
  it('refuses a glob refspec on either side of the colon', () => {
    for (const spec of ['+refs/heads/main*:refs/heads/main*', 'refs/heads/*:refs/heads/*', 'main:ma*n']) {
      const r = parsePushRefspec(spec)
      expect(r.ok, spec).toBe(false)
      expect(!r.ok && r.reason, spec).toBe('glob')
    }
  })

  // Breaks on: removing the leading-'-' reject, OR removing the SECOND one that
  // runs on the derived destination. `+main:--all` survives the first check (it
  // starts with '+'), strips to `main:--all`, and would hand `--all` to
  // `git rev-parse`, which returns rc=0 and a LIST of every ref.
  it('refuses an option-shaped value in the input AND in the derived destination', () => {
    for (const spec of ['--mirror', '--all', '-M', '+main:--all', 'HEAD:--git-dir']) {
      const r = parsePushRefspec(spec)
      expect(r.ok, spec).toBe(false)
      expect(!r.ok && r.reason, spec).toBe('option_shaped')
    }
  })

  // Breaks on: deleting the FIRST leading-dash check (the one on the whole
  // refspec). Every case in the test above is also caught by the SECOND check,
  // on the destination — so with only those, deleting the first check leaves the
  // suite green. This is the shape that separates them: the SOURCE is
  // option-shaped and the destination is clean, so the parse would succeed with
  // destination 'main', and the value would only be stopped much later by
  // `unsafeOperand` at the exec site — a different reject kind, after two more
  // git calls, one of them handing the token to `rev-parse`.
  //
  // Unlike the glob input check (measured unreachable and deleted), this one is
  // load-bearing. The mutation harness said SURVIVED and the honest reading was
  // a missing test, not dead code — the two look identical until you name the
  // shape only the first check catches.
  it('refuses an option-shaped SOURCE even when the destination is clean', () => {
    for (const spec of ['--all:main', '--exec=/tmp/x:main', '-M:feat/x']) {
      const r = parsePushRefspec(spec)
      expect(r.ok, spec).toBe(false)
      expect(!r.ok && r.reason, spec).toBe('option_shaped')
    }
  })

  // Breaks on: an over-strict predicate. These are ordinary push targets and a
  // false reject here is a hard stop with no override path, before any dialog.
  it('accepts the push targets real work uses', () => {
    for (const spec of ['main', 'feat/x', 'release/2.0', 'HEAD', '@', 'feat/café', 'v1.0.0']) {
      expect(parsePushRefspec(spec).ok, spec).toBe(true)
    }
  })

  it('every reject reason produces a message naming the offending value', () => {
    for (const reason of ['option_shaped', 'glob', 'empty_destination'] as const) {
      expect(pushRefspecRejectReason(reason, '+main:--all')).toContain('+main:--all')
    }
  })
})

describe('#62 B3 — the SOURCE half of the refspec', () => {
  // request-push reads <remote>/<destination>...<source>. The source is produced
  // by the same last-colon split as the destination and was previously computed
  // and discarded; a second copy of that split in the caller is how the two drift.
  // Breaks on: returning the whole body as the source when a colon is present.
  it.each([
    ['main', 'main', 'main'],
    ['feat/x:main', 'feat/x', 'main'],
    ['+feat/x:main', 'feat/x', 'main'],
    ['HEAD:main', 'HEAD', 'main'],
    ['HEAD:a:refs/heads/main', 'HEAD:a', 'refs/heads/main'],
  ])('%s splits into source %s / destination %s', (spec, source, destination) => {
    const r = parsePushRefspec(spec)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.source).toBe(source)
    expect(r.destination).toBe(destination)
  })

  // A DELETE refspec carries no files, so it must yield an EMPTY source rather
  // than the destination — the caller uses that emptiness to skip the coverage
  // check instead of composing a meaningless range.
  // Breaks on: falling back to the destination when the source side is empty.
  it('gives a delete refspec an empty source, not the destination', () => {
    const r = parsePushRefspec(':main')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.source).toBe('')
    expect(r.destination).toBe('main')
  })
})
