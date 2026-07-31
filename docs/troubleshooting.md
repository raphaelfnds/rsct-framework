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

## "This project was set up with RSCT vX; the installed rsct-mcp is vY"

An **install-drift** notice: the framework in this project is older than the
`rsct-mcp` binary running against it, so newer rules, prompts and markers are not
applied here yet. It is a suggestion, never a block.

Fix: re-run `/rsct-setup` in the project. Nothing is lost — setup is idempotent
and preserves your answers.

## "⚠ SECURITY: an RSCT enforcement script is missing from this project"

The scripts under `.rsct/scripts/` are what actually enforce things:
`sanitize-permissions.js` strips permission entries that would let the agent
commit without asking you, and `edit-scope-guard.js` blocks edits outside the
current task's scope. This message means one of them **is not installed**, so
what it enforces is not running here. It never blocks anything.

Most common cause: the project was set up before that script existed, or before
the `rsct-mcp` companion was installed.

Fix:

1. Run `/rsct-setup` — it installs the scripts and registers their hooks.
2. **Fully restart the IDE.** The running server compares against the copy it
   ships; until it restarts you may still see the old message.
3. Confirm with `rsct_status` that the message is gone.

If it survives that:

- `ls .rsct/scripts/` should list `sanitize-permissions.js`,
  `edit-scope-guard.js` and a small `package.json`. If they are missing,
  `/rsct-setup` could not find the `rsct-mcp` package to copy them from — it
  looks in `npm root -g`, so a server registered by absolute path or via `npx`
  will not be found. Install it globally (`cd mcp-server && npm install -g .`)
  and re-run.
- The scripts only run if their hooks are registered. Check `.claude/settings.json`
  for `hooks.SessionStart` and `hooks.PreToolUse` entries pointing at
  `.rsct/scripts/`.

## "This project's RSCT enforcement scripts are not the ones rsct-mcp vX ships"

Lower-key than the message above, and usually harmless: the scripts are present,
they just are not byte-identical to the copies the running server carries. Almost
always it means the project has not been re-synced since a framework update.

It does **not** mean a fix is missing. Those scripts are bundles — they embed
config and helper code — so an unrelated change elsewhere in the framework
changes their bytes. RSCT only reports that they differ, because that is all it
can prove locally.

Fix: run `/rsct-setup`, then restart the IDE.

Two cases where the message is expected and fine:

- `.rsct/scripts/` is committed to the repo, so a teammate whose global
  `rsct-mcp` is older than the committed scripts will see it until they update
  the binary. Update `rsct-mcp` — do not re-run setup to "fix" it, that would
  push the scripts backwards.
- You updated the binary and ran `/rsct-setup` but have not restarted the IDE
  yet.

## "commit message has N non-empty lines; the limit is 15"

`rsct_request_commit` rejected the commit before asking you to approve anything —
nothing was committed and no approval was spent. Rewrite the message shorter and
call it again.

The rule: say what changed and why. The diff already shows the file-by-file
detail, and a long body encodes a session narrative that ages badly and makes
`git log` unscannable. Blank lines are not counted, so paragraph spacing is free.

If your project genuinely wants longer messages, set a number in `.rsct.json`:

```json
{ "commit_message_max_lines": 30 }
```

Note the value is a **number**, not a string — `"30"` in quotes is rejected by
the config schema.

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
case-sensitively). **`rsct_get_topology` surfaces this for you**: it warns when a
`producer` matches no registered app, and flags a case-only mismatch as a likely
typo with the correctly-cased name to use. The same warning covers every contract
`consumer` and this repo's own `app.name` (a case-only drift is flagged as a
likely typo, though only the `producer` gates). If you'd rather check by hand, the
`producer` string must equal the app's `name` in its `.rsct.json` exactly.

## Uninstall says the project is a legacy (pre-marker) install

A project set up by a pre-1.0.0 RSCT version has no reversibility markers, so
`/rsct-uninstall` can't auto-restore it. Clean it up by hand (or `git checkout`
the pre-RSCT state). Current installs always write the markers needed for a clean
reversal.

---

See also: [Getting started](getting-started.md) ·
[Command reference](commands.md) · [Multi-repo & contracts](multi-repo.md).
