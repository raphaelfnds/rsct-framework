# Contributing to the RSCT Framework

Thanks for your interest in improving RSCT! This document covers how to set up,
the conventions this repository follows, and the one rule that breaks more PRs
than any other: **cross-OS correctness**.

> The RSCT Framework is **not installed in its own repository** — there is no
> `.rsct.json` and no MCP server driving gates here, so the cycle it enforces
> mechanically in a managed project is followed by hand.
> [AGENTS.md](AGENTS.md) is that contract: the session protocol, the tier
> classification, and where an explicit developer OK stands in for a gate.
> [CLAUDE.md](CLAUDE.md) holds the engineering rules that bind any change here —
> read both before proposing changes, especially the "Padrões a evitar nos
> prompts bash" (anti-patterns) section.

---

## Project layout

| Path | What it is |
|---|---|
| `prompts/` | The slash-command playbooks (`/rsct-setup`, `/rsct-uninstall`, …) — portable bash. |
| `rules/` | The §0 + §A–§H governance rules inserted into each project's `CLAUDE.md`. |
| `doc-templates/` · `memory-templates/` · `universe-templates/` | Scaffolding rendered into target projects. |
| `mcp-server/` | The `rsct-mcp` companion (TypeScript MCP server) — the mechanical enforcement layer. |
| `scripts/install.sh` | Cross-OS installer. |

## Development setup (`rsct-mcp`)

```bash
cd mcp-server
npm install
npm run typecheck  # tsc --noEmit — vitest does NOT type-check; this is its own CI gate
npm run build      # tsup → dist/
npm test           # vitest (full suite)
```

Requires **Node 20+**.

### On Windows, the suite needs Git Bash — it finds it for you

The `tests/bash/` files hand a Windows path to `bash`. Windows ships several different
`bash` binaries, and `bash` on `PATH` is frequently WSL's — which mounts drives at
`/mnt/c/`, consumes the backslashes in `C:\Users\…`, and reports *"No such file or
directory"* for a file that was written correctly. The message reads as broken prompt
logic, which is the wrong conclusion.

The harness therefore **resolves** bash instead of trusting `PATH`
(`tests/bash/lib/resolve-bash.ts`): on Windows it takes the first candidate whose
`uname -s` is `MINGW*` or `MSYS*`, deriving Git Bash from `git --exec-path` before
falling back to `%ProgramFiles%` and `PATH`. So `npm test` works from PowerShell, cmd or
Git Bash alike. **On Linux and macOS nothing changed** — the platform check returns the
literal `bash` before any of that logic runs.

- **On Windows only**, set `RSCT_BASH` to an absolute `bash.exe` to override the search.
  It is an instruction, not a suggestion: if it points at something unusable the suite
  fails naming it, rather than quietly falling back to another candidate. (Elsewhere the
  variable is ignored — the platform check returns before it is read.)
- Only `MINGW*` and `MSYS*` are accepted. WSL is the binary this exists to reject, and
  Cygwin is excluded too: it is a third flavour that no test here has ever exercised, so
  accepting it would widen the contract past what is verified. [README.md](README.md)
  binds *users* installing the framework to Git Bash for a related reason — different
  audience, same binary.
- If no usable bash is found, a test fails with the binary it found, its `uname -s`,
  every candidate it tried and both fixes — and the bash-dependent blocks skip instead
  of producing the 71 failures that all say "No such file or directory".

---

## The #1 rule: everything must work on all three OS families

Every change to bash prompts, scripts, `rsct-mcp` code, or templates **must work
without regression on Windows (Git Bash / MSYS2), Linux (GNU coreutils), and
macOS (BSD coreutils)**. "Works on my Windows" is not proof of done.

The most dangerous bugs here are **silent** — e.g. BSD `grep` on macOS treats a
GNU-only `\|` alternation as a literal and returns empty with no error. The
catalogue of historical cross-OS breakages and the patterns that prevent them is
in [CLAUDE.md](CLAUDE.md). Highlights:

- Prefer **POSIX** over GNU extensions (ERE `-E` over BRE; `[|]` over `\|`).
- `tr -d '\r'` before any `$`-anchored regex or SHA pipeline (CRLF tolerance).
- Never combine `grep -i` **and** `-F` (SIGABRTs on the Git Bash grep 3.0).
- Build backslashes in `node -e` via `String.fromCharCode(92)`, not literals.

When in doubt, add a smoke test and reason through each OS before shipping.

## The `rsct-mcp` binary ships prebuilt (`dist/` is tracked)

To keep user installs free of a build toolchain (and `npm audit` clean), the
compiled `mcp-server/dist/` is **committed**. If you change anything under
`mcp-server/src/`, you **must rebuild and re-commit** the artifact:

```bash
cd mcp-server
npm run verify:dist     # rebuilds and fails if the tracked dist/ is stale
```

Run this before committing. **CI also runs it**, on a single matrix cell
(ubuntu-latest, node 22) — chosen for cost, not for correctness. The bundle *is*
byte-reproducible across OSes: a native Linux build of this lockfile yields
`index.js`, `sanitize-permissions.js` and `edit-scope-guard.js` byte-identical to
the Windows-built committed copies. esbuild is a Go binary whose codegen is
deterministic per version, `.gitattributes` pins `eol=lf` so no CRLF can reach a
template literal, and sourcemaps (`dist/**/*.map`) stay gitignored.

The `--intent-to-add` in the script is load-bearing: `git diff` ignores untracked
files, so without it a **newly added** artifact (a new `tsup` entry, say) would
pass the check while never being committed — CI green, users installing without
the file.

The three bundles are tracked with mode `100755`. They carry a shebang and are
what `package.json` `bin` points at, so executable is the correct mode — and it
has to be recorded in the index, because `git diff` compares mode as well as
content: `tsup` on Linux sets the execute bit, Windows git does not track it, and
without an agreed mode the CI check fails on a byte-identical build. If you ever
add a `dist/` entry, mark it too: `git update-index --chmod=+x <path>`.

---

## Branches, commits, and PRs

- **Never commit to `main` directly.** Derive a branch: `feat/…`, `fix/…`,
  `chore/…`, or `docs/…`.
- Merge with **`--no-ff`** so each change keeps a merge commit.
- User-facing changes get an entry in [CHANGELOG.md](CHANGELOG.md) under
  `[Unreleased]`. Substantial changes are tracked with a **CAP-NN** number
  (see the changelog history for the convention).
- When bumping the product version, the single edit point is **`/VERSION`** at
  the repo root (issue #7). Edit `/VERSION`, then run `npm run sync-version` from
  `mcp-server/` — it regenerates `src/lib/version.ts` and updates
  `package.json` + `package-lock.json` in lockstep. **Do NOT hand-edit
  `version.ts`** (it is derived — the `version-source.test.ts` parity test catches
  drift). The marker **schema id** (`v=1.0.0`) is a SEPARATE axis: it keys marker
  idempotency, stays frozen across releases, and is NOT bumped with the version.
- Open a PR against `main`. Fill in the PR checklist.

## Tests

- Add or update `vitest` tests for any `rsct-mcp` behavior change.
- `npm test` must be green before requesting review. `npm run typecheck` is a
  separate gate — vitest transpiles without type-checking, so a wrong call shape
  runs happily and silently returns the wrong thing.
- When you touch `prompts/*.md`, run `RSCT_REQUIRE_BASH=1 npm test`. Without that
  variable the `bash -n` lint gate **skips silently** instead of failing; CI sets it.
- For bash changes that can't be unit-tested, include a smoke test in the PR
  description and a post-mutation sanity check in the script itself.
- **Never remove or bypass `mcp-server/tests/setup.ts`.** It is wired through
  `vitest.config.ts` (`setupFiles`) and sets `RSCT_UPDATE_CHECK=off` for the whole
  suite. It is the only thing keeping the tests off the real GitHub API and out of
  your real `~/.rsct/update-check.json` — `statusHandler` resolves the real `$HOME`
  and the real `fetch` whenever nothing is injected, and roughly sixteen call sites
  across the status / load-context / topology / universe tests inject nothing. A
  test that exercises the update check on purpose passes
  `update: { home: <tmpdir>, env: {}, fetcher }` through `statusHandler`'s `deps`
  seam — `env: {}` against the real `$HOME` is exactly the combination to avoid.
- Prefer assertions that would FAIL against a broken implementation. A network
  assertion on a *fresh* cache proves nothing, because no build would fetch from
  one; seed a stale cache so the gate under test is the only thing preventing the
  call.

## Reporting bugs / requesting features

Use the issue templates. For bugs, the **operating system** and **AI tool** are
required — most reports hinge on them.

## Security

Please do not open public issues for vulnerabilities — see [SECURITY.md](SECURITY.md).

## Code of conduct

Participation is governed by our [Code of Conduct](CODE_OF_CONDUCT.md).
