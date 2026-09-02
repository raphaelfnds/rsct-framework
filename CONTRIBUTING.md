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

### Adding a tool: `src/catalog.ts` is what decides it exists

A new tool module under `mcp-server/src/tools/` reaches the server **only** by being
registered in **`mcp-server/src/catalog.ts`** — its `Tool` in `TOOLS`, its handler in
`HANDLERS`. `src/index.ts` takes its entire tool surface from those two exports (the
other things it serves are resources, which come from `src/resources.ts`), so a module
that compiles, type-checks and has green unit tests is still invisible to every client
until that row exists.

`tests/unit/tool-registration.test.ts` enforces it: it enumerates `src/tools/` and fails
when a declared tool name is absent from the catalog. Three conventions it relies on, all
of which it names in the failure if you break them:

- `src/tools/` is **flat**, and holds only `.ts` files. The scan does not recurse and
  does not read other extensions, so it fails on a subdirectory or a `.mts` rather than
  passing over it.
- the tool name is a plain single-quoted literal following the indentation directly —
  `name: 'rsct_…'`. Digits are fine; a trailing comma or comment is fine.
- `NON_TOOL_MODULES` in that test exempts a module that declares **no** tool at all — a
  shared helper, a types module. **It is never the fix for a tool that failed to parse.**
  A separate assertion re-checks every unparsed module for anything that *looks* like a
  tool declaration and stays red regardless of the allowlist, so exempting a real tool
  cannot make the suite green.

Adding or removing a tool also reddens `tests/unit/tool-count.test.ts`, which pins the
documented count, the group breakdown and the startup name list across `README.md`,
`mcp-server/README.md`, `examples/README.md` and `scripts/install.sh`. Read that test for
the current list of anchors rather than trusting a count written here.

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
