<!-- Thanks for contributing! Please complete the checklist below. -->

## What & why

<!-- Summarize the change and the motivation. Link any related issue. -->

## Checklist

- [ ] **Cross-OS considered** — works on Windows (Git Bash), WSL, Linux, and macOS
- [ ] Followed the bash anti-patterns in [CLAUDE.md](../CLAUDE.md) (no `\|` BRE, no `grep -i` + `-F`, CRLF-safe, etc.)
- [ ] `npm run typecheck`, `npm run build` and `npm test` are green (in `mcp-server/`) — `typecheck` is a separate CI gate; vitest does not type-check
- [ ] Ran `npm run verify:dist` if I changed `mcp-server/src/` (rebuilt + committed `dist/`)
- [ ] If I added a tool, it is registered in **`mcp-server/src/catalog.ts`** (`TOOLS` + `HANDLERS`) — that file, not the README, is what decides the tool exists
- [ ] **Docs match the code**: updated every page the change touches — `README.md`, `docs/`, `mcp-server/README.md` (tool catalog, env vars, milestone table), `CONTRIBUTING.md`, `rules/`, `memory-templates/`, prompt prose — or confirmed none apply
- [ ] If the change alters what an agent should DO, it reaches installed projects: `rules/` is never overwritten on an existing install, so the instruction must also travel via `memory-templates/` or the tool's `description` text
- [ ] Updated [CHANGELOG.md](../CHANGELOG.md) under `[Unreleased]`
- [ ] No real client/company names or secrets introduced
- [ ] Branch is derived (`feat/`, `fix/`, `chore/`, `docs/`) — not a direct commit to `main`
- [ ] **Framework surfaces** — if this touches `rules/`, `prompts/`, `mcp-server/src/`, `doc-templates/` or `memory-templates/`, the cycle in [AGENTS.md](../AGENTS.md) was run: tier stated, spec approved before code, and V + REVIEW for `standard`/`complex`
