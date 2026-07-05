# Contributing to the RSCT Framework

Thanks for your interest in improving RSCT! This document covers how to set up,
the conventions this repository follows, and the one rule that breaks more PRs
than any other: **cross-OS correctness**.

> The RSCT Framework **governs its own development** (it dogfoods itself). The
> operational notes for contributors and AI agents working *on* this repo live
> in [CLAUDE.md](CLAUDE.md) — read it before proposing changes, especially the
> "Padrões a evitar nos prompts bash" (anti-patterns) section.

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
npm run build      # tsup → dist/
npm test           # vitest (full suite)
```

Requires **Node 20+**.

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

Run this before committing; CI does not (the build is not byte-reproducible
across OSes, so `verify:dist` is a local, same-environment guard). Sourcemaps
(`dist/**/*.map`) stay gitignored.

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
- `npm test` must be green before requesting review.
- For bash changes that can't be unit-tested, include a smoke test in the PR
  description and a post-mutation sanity check in the script itself.

## Reporting bugs / requesting features

Use the issue templates. For bugs, the **operating system** and **AI tool** are
required — most reports hinge on them.

## Security

Please do not open public issues for vulnerabilities — see [SECURITY.md](SECURITY.md).

## Code of conduct

Participation is governed by our [Code of Conduct](CODE_OF_CONDUCT.md).
