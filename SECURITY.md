# Security Policy

## Reporting a vulnerability

**Please do not report security issues through public GitHub issues, discussions,
or pull requests.**

Instead, use GitHub's **private vulnerability reporting**:

1. Go to the repository's **Security** tab → **Report a vulnerability**.
2. Describe the issue, affected version, and reproduction steps.

We aim to acknowledge a report within a few days and will keep you updated on the
fix and disclosure timeline. Responsible disclosure is appreciated.

## Supported versions

| Version | Supported |
|---|---|
| Latest release | ✅ |
| Anything older | ❌ (superseded — upgrade to the latest release) |

Only the latest release is supported. RSCT ships as prompts plus a single MCP
binary with no runtime state to migrate, so upgrading is a `git pull`, a
reinstall, and a `/rsct-setup` re-run.

## Network behaviour

RSCT makes **one** kind of outbound request, and only from the update check:

```
GET https://api.github.com/repos/raphaelfnds/rsct-framework/releases/latest
Accept: application/vnd.github+json
User-Agent: rsct-mcp/<version>
```

Unauthenticated, at most once per 24 hours, 2-second timeout, fail-silent. **No
project data, no code, no file names, no telemetry, and nothing identifying you.**
As with any HTTPS request, GitHub receives your IP, the time, and that
`User-Agent` — which names the RSCT version you are running.

Since v2.6.0 this runs **by default**. Turn it off with `RSCT_UPDATE_CHECK=off`
in the environment (this also applies before any session exists — CI, headless),
by asking Claude to call `rsct_status` with `update_check:"off"`, or by writing
`"consent": "no"` into `~/.rsct/update-check.json`. See
[README § Update check](README.md#update-check-what-leaves-your-machine-and-how-to-turn-it-off).

Nothing else in the framework opens a network connection. The install-drift check
(`lib/version-drift.ts`) is a purely local comparison and is deliberately kept in a
separate module for that reason.

## Scope notes

### `rsct-mcp` is not distributed through npm

The companion is installed by `scripts/install.sh` from a clone of this repository:
it runs from a copy in `~/.rsct/mcp-server`, and the global `rsct-mcp` command is an
npm *link* to that copy. This project publishes nothing to the npm registry. A package
named `rsct-mcp` found there is not ours — do not install it, and please report it
privately as above. A linked install is not replaced by a registry package of the same
name on `npm update -g` (measured on npm 10.9.2 and 11.1.0; see `docs/decisions.md`,
AD-007).

### `esbuild` advisories in the build toolchain

`npm audit` may report advisories on **`esbuild`**, which reaches a developer
machine only as a **transitive dev-dependency** of the build/test toolchain
(`tsup`, `vitest`). It is **not a runtime dependency** and is **not part of the
shipped artifact**:

- The shipped `rsct-mcp` runs from the prebuilt `dist/`, which does not load
  `esbuild`.
- End-user installs use the prebuilt `dist/` and never install the build
  toolchain (see `CHANGELOG.md`, CAP-57), so `npm audit` is clean for them.
- The known `esbuild` vectors (Deno install integrity; the dev-server file-read)
  do not apply to this project's build or runtime.

These advisories are therefore **informational for contributors** and are not
considered exploitable in normal use. If you believe otherwise, please report it
privately as above.
