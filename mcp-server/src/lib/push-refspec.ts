/**
 * #62 B5 — what a `git push` refspec actually WRITES TO, so branch protection
 * (INV-5) compares against the destination instead of the string the agent typed.
 *
 * The hole this closes, measured on git 2.45.1.windows.1 against a real bare
 * remote. `isProtectedBranch` is `list.includes(branch)` over the raw input, so
 * every one of these is colon-free-or-not but compares unequal to `'main'`, skips
 * the whole protected block in `rsct_request_push` — no `pre_merge_ack`, no
 * `override_protected_branch` — and still lands on the remote's `main`:
 *
 *     git push origin '+main'      rc=0, FORCE-UPDATED a diverged protected main
 *     git push origin 'HEAD:main'  rc=0
 *     git push origin ':main'      deletes it
 *     refs/heads/main · heads/main · HEAD · @   all resolve to refs/heads/main
 *
 * `git check-ref-format --branch '+main'` returns rc=0, so git's own validator is
 * no help. `:` was the ONLY variant git already refused on its own — which is why
 * a fix aimed at colons alone would have closed the single door already shut.
 *
 * This module is PURE and does the string half only. Resolution against the ref
 * store is the caller's job (`request-push.ts`), because it needs git and this
 * must stay unit-testable. `isProtectedBranch` stays pure and untouched: it has
 * six call sites and only the push tool passes a refspec — the other five pass an
 * already-canonical `gitState.branch` and ask "am I standing on a protected
 * branch", a question destination resolution cannot answer.
 */

/** Why a refspec was refused before it ever reached git. */
export type PushRefspecReject = 'option_shaped' | 'glob' | 'empty_destination'

export type PushRefspecParse =
  | {
      ok: true
      /**
       * Names to test against the protected list, deduped. Always contains the
       * destination as written plus its `refs/heads/`- and `heads/`-stripped
       * forms; the caller appends whatever the ref store resolves.
       */
      candidates: string[]
      /** The destination exactly as written, after the `+` strip and `:` split. */
      destination: string
      /**
       * The LOCAL side of the refspec — what is being pushed FROM — after the
       * `+` strip and the same last-colon split. Equal to `destination` when the
       * refspec carries no colon, and `''` for a delete refspec (`:main`).
       *
       * Exposed rather than recomputed by the caller (#62 B3 reads
       * `<remote>/<destination>...<source>` for the coverage cross-check): the
       * last-colon split is subtle enough that it was verified twice against git,
       * and a second copy of it in `request-push.ts` is how the two drift.
       */
      source: string
      /** True when a leading `+` was stripped — i.e. this push is a FORCE. */
      forced: boolean
    }
  | { ok: false; reason: PushRefspecReject }

/**
 * Strip a `refs/heads/` or `heads/` prefix. Both forms resolve to the same
 * branch, and the protected list holds BARE names (`branch-protection.ts`), so
 * without this the comparison silently never matches — measured: `rev-parse`
 * returns `refs/heads/main`, and `'refs/heads/main' === 'main'` is false, which
 * on its own would have turned the whole gate into a no-op.
 */
export function stripRefsPrefix(ref: string): string {
  if (ref.startsWith('refs/heads/')) return ref.slice('refs/heads/'.length)
  if (ref.startsWith('heads/')) return ref.slice('heads/'.length)
  return ref
}

/**
 * Parse the destination out of a push refspec.
 *
 * The step ORDER is forced by measurement and must not be rearranged:
 *
 * 1. **Reject a leading `-` first.** This is the layer that catches an
 *    option-shaped SOURCE with a clean destination — `--all:main` parses to
 *    destination `main`, so nothing later in this function sees it. Be exact
 *    about what it buys: it is an EARLIER and clearer reject, not the sole
 *    closure of the exec vector. `unsafeOperand` in `lib/git.ts` is the backstop
 *    and would refuse the same value at the exec site; this one stops it before
 *    two more git calls are made.
 * 2. Strip a leading `+` (git's force marker; it strips it too).
 * 3. Split on the LAST `:`. Verified twice: `push origin 'main:refs/heads/zz:qq'`
 *    reports src `main:refs/heads/zz`, and `'HEAD:a:refs/heads/main'` parses dst
 *    `refs/heads/main`. A first-colon split reads that dst as `a:refs/heads/main`
 *    and misses. No legitimate branch name can contain `:` — `check-ref-format
 *    --branch 'a:b'` is rc=128 — so the split is lossless.
 * 4. **Reject an empty destination.** The bare `:` is git's "matching" refspec:
 *    it pushes every matching ref, protected ones included, and an empty
 *    destination matches nothing in the list, so the gate would pass.
 * 5. **Re-apply the `-` reject to the DESTINATION.** `+main:--all` survives step
 *    1 (it starts with `+`) and strips to `main:--all`. The rule has to run on
 *    the derived value, not only on the input.
 *
 *    What this actually prevents was measured, and it is NOT option injection:
 *    `git push origin 'main:--all'` is rc=0 and creates a branch literally named
 *    `refs/heads/--all` on the remote. So this is defence in depth against
 *    writing a garbage ref that is then awkward to remove — the exec vectors are
 *    all PRE-colon and step 1 is what addresses those.
 *
 *    This reject is ALSO what keeps `request-push`'s `rev-parse` call safe, and
 *    that dependency runs the opposite way from what this docblock first claimed
 *    (Rv-A). The original text said the resolver was protected by passing `--`
 *    to `rev-parse`. Measured: `--` puts rev-parse into echo-the-operands mode,
 *    so it returned `--` and the operand for EVERY input and the caller's
 *    canonicalization arm never ran at all. The `--` has been removed there, and
 *    the reason that is safe is THIS step — `--all`, `--branches` and every
 *    other selector start with `-` and never reach the call. A "reject
 *    multi-line output" guard at the call site would not substitute for it:
 *    `rev-parse --symbolic-full-name --all` returns a single line in a
 *    single-ref repo.
 * 6. **Reject `*` in the DESTINATION.** `git push origin
 *    '+refs/heads/main*:refs/heads/main*'` is rc=0 and force-updates a protected
 *    branch while the plain push of the same state is refused rc=1; `rev-parse`
 *    treats the glob as a no-op and echoes it back, so canonicalization cannot
 *    see it. `*` is the only legal refspec glob (`?` and `[m]` are `fatal:
 *    invalid refspec`).
 *
 *    Checked on the DESTINATION only, and that is a measured decision rather than
 *    an oversight: a glob confined to the source side is refused by git itself —
 *    `+refs/heads/*:refs/heads/main` and `ma*n:main` are both `fatal: invalid
 *    refspec` — so an input-level check for `*` could never fire on a shape git
 *    would accept. It was written, measured to be unreachable, and removed.
 */
export function parsePushRefspec(refspec: string): PushRefspecParse {
  if (refspec.startsWith('-')) return { ok: false, reason: 'option_shaped' }

  const forced = refspec.startsWith('+')
  const body = forced ? refspec.slice(1) : refspec

  const lastColon = body.lastIndexOf(':')
  const destination = lastColon >= 0 ? body.slice(lastColon + 1) : body
  const source = lastColon >= 0 ? body.slice(0, lastColon) : body

  if (destination.length === 0) return { ok: false, reason: 'empty_destination' }
  if (destination.startsWith('-')) return { ok: false, reason: 'option_shaped' }
  if (destination.includes('*')) return { ok: false, reason: 'glob' }

  const candidates = [...new Set([destination, stripRefsPrefix(destination)])]
  return { ok: true, candidates, destination, source, forced }
}

/** Human-readable reason for a refused refspec, for the reject envelope. */
export function pushRefspecRejectReason(
  reason: PushRefspecReject,
  refspec: string,
): string {
  const subject = `push target ${JSON.stringify(refspec)}`
  switch (reason) {
    case 'option_shaped':
      return `${subject} starts with '-', which git reads as an OPTION rather than a branch. Pass a plain branch name.`
    case 'glob':
      return `${subject} contains '*'. A glob refspec can rewrite branches the branch-protection check never sees, so it is refused. Push one branch at a time.`
    case 'empty_destination':
      return `${subject} has an empty destination. A bare ':' is git's "matching" refspec — it pushes every matching ref, protected branches included. Name the branch explicitly.`
  }
}
