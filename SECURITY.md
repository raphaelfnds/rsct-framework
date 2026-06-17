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
| `1.0.x` | ✅ |
| `< 1.0` | ❌ (pre-release dev trains) |

## Scope notes

### `esbuild` advisories in the build toolchain

`npm audit` may report advisories on **`esbuild`**, which reaches a developer
machine only as a **transitive dev-dependency** of the build/test toolchain
(`tsup`, `vitest`). It is **not a runtime dependency** and is **not part of the
shipped artifact**:

- The published `rsct-mcp` runs from the prebuilt `dist/`, which does not load
  `esbuild`.
- End-user installs use the prebuilt `dist/` and never install the build
  toolchain (see `CHANGELOG.md`, CAP-57), so `npm audit` is clean for them.
- The known `esbuild` vectors (Deno install integrity; the dev-server file-read)
  do not apply to this project's build or runtime.

These advisories are therefore **informational for contributors** and are not
considered exploitable in normal use. If you believe otherwise, please report it
privately as above.
