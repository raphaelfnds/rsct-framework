# Troubleshooting

Common failures and their fixes. If something here doesn't match what you see,
it may be a bug worth filing.

## `/rsct-setup` (or any `rsct-*` command) shows "No matching commands"

Slash commands load at IDE startup. You installed (or updated) while the IDE was
running. **Fully close and reopen Claude Code / VSCode** — not just the chat
panel. The command appears after the restart.

## The `rsct_*` MCP tools don't appear

The companion server isn't registered or connected.

1. Confirm it's registered: `claude mcp list` from inside the project — expect a
   line like `rsct: rsct-mcp - ✓ Connected`.
2. If it's missing, register it: `claude mcp add rsct rsct-mcp --scope user` (or
   `--scope project` for a committable `.mcp.json`). Then **restart**.
3. Confirm the binary is on PATH: `which rsct-mcp` (macOS/Linux/Git Bash) or
   `where rsct-mcp` (Windows). If it prints nothing, re-run the installer (or
   `cd mcp-server && npm install -g .`).
4. Confirm it boots: `rsct-mcp < /dev/null` (Git Bash/macOS/Linux) or
   `cmd /c "rsct-mcp < NUL"` (PowerShell) should print a one-line ready log on
   stderr and exit cleanly.

If the tools were there before and vanished, the global binary may be pointing at
a clone without its dependencies built — re-install/re-link the global `rsct-mcp`.

## Windows: `LF will be replaced by CRLF` warnings

Harmless. RSCT strips `\r` before every SHA it computes, so a CRLF round-trip
never turns a clean re-run into a spurious update. To silence the warnings, add a
`.gitattributes` pinning the RSCT artifacts to `eol=lf` — see the
[root README](../README.md#windows-line-endings-the-lf-will-be-replaced-by-crlf-warning).

## `/rsct-setup` stops, saying this is a universe repo

You ran it inside a universe (a repo with a `.universe.json` marker). That's
intentional: a universe is governance infrastructure, not an app. Edit the
universe's files (`.universe.json`, `contracts.json`, governance docs) by hand
and commit them yourself. Run `/rsct-setup` in your **app** repos instead.

## The contract gate isn't doing what I expect

The contract-surface gate is deliberately narrow. It fires **only** when all of
these hold, and only in the **producer** repo:

- the app's confirmed `topology.mode` is `multi-repo` (an inferred mode that you
  never confirmed at `/rsct-setup` does **not** gate);
- the universe is linked and resolvable;
- `contracts.json` exists at the universe root;
- the commit touches a path matching one of *this app's* declared surfaces;
- the commit is in the **producer** repo — **consumer repos are never blocked by
  the surface gate**.

So:

- **Gate never fires when I expected it to.** Check, in order: is the topology
  *confirmed* `multi-repo` (not just inferred)? Is the universe resolvable
  (`rsct_get_topology` reports its path)? Does `contracts.json` exist and parse?
  Does the `producer` field equal your `app.name` **exactly, case-sensitively**?
  Do your `surface` globs actually match the staged paths (remember `{a,b}` /
  `[abc]` are literal, not patterns — see
  [surface glob syntax](multi-repo.md#surface-glob-syntax))?
- **Gate fires and I want to proceed.** Approve the commit with a per-action
  override that includes a reason. A batch plan-authorization token will **not**
  bypass the gate — that's a hard block; give the explicit per-action override.
- **I expected protection on the consumer side.** The surface gate is
  producer-side only by design. Consumer repos commit freely; their job is to
  track the contract graph, not to be blocked by it. See
  [Producer vs consumer](multi-repo.md#producer-vs-consumer).

## A producer name doesn't match any app

If a `contracts.json` `producer` matches no registered `app.name`, the gate for
that contract silently never fires (the names must match exactly,
case-sensitively). Until a release surfaces this automatically, check the names
by hand: the `producer` string must equal the app's `name` in its `.rsct.json`.

## Uninstall says the project is a legacy (pre-marker) install

A project set up by a pre-1.0.0 RSCT version has no reversibility markers, so
`/rsct-uninstall` can't auto-restore it. Clean it up by hand (or `git checkout`
the pre-RSCT state). Current installs always write the markers needed for a clean
reversal.

---

See also: [Getting started](getting-started.md) ·
[Command reference](commands.md) · [Multi-repo & contracts](multi-repo.md).
