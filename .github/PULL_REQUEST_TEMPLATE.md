<!-- Thanks for contributing! Please complete the checklist below. -->

## What & why

<!-- Summarize the change and the motivation. Link any related issue. -->

## Checklist

- [ ] **Cross-OS considered** — works on Windows (Git Bash), WSL, Linux, and macOS
- [ ] Followed the bash anti-patterns in [CLAUDE.md](../CLAUDE.md) (no `\|` BRE, no `grep -i` + `-F`, CRLF-safe, etc.)
- [ ] `npm run build` and `npm test` are green (in `mcp-server/`)
- [ ] Ran `npm run verify:dist` if I changed `mcp-server/src/` (rebuilt + committed `dist/`)
- [ ] Updated [CHANGELOG.md](../CHANGELOG.md) under `[Unreleased]`
- [ ] No real client/company names or secrets introduced
- [ ] Branch is derived (`feat/`, `fix/`, `chore/`, `docs/`) — not a direct commit to `main`
