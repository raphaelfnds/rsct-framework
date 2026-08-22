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
2. **`⏸ Pending approval`?** The entry is registered but the project has not
   approved it — a `.mcp.json` never spawns until it does. `/rsct-setup` writes
   the approval into `<project>/.claude/settings.local.json`
   (`"enabledMcpjsonServers": ["rsct"]`); so does answering the prompt Claude
   Code shows when you first open the project. That file is per-developer and
   gitignored — each teammate approves on their own machine.
   If you once answered *no*, the refusal sits in `disabledMcpjsonServers` and
   **wins** over any approval; remove it there yourself.
3. If it's missing entirely, re-run the installer and pick a scope. Beware the
   manual shortcut: `claude mcp add rsct rsct-mcp --scope user` registers at
   **user scope**, which *masks* any project `.mcp.json` on the whole machine —
   on a team setup that silently disables the registration your repo shares.
   Use `--scope project` inside the project instead, or let `/rsct-setup` do it.
   Then **restart**.
4. Confirm the binary is on PATH: `which rsct-mcp` (macOS/Linux/Git Bash) or
   `where rsct-mcp` (Windows). If it prints nothing, re-run the installer (or
   `cd mcp-server && npm install -g .`).
5. Confirm it boots: `rsct-mcp < /dev/null` (Git Bash/macOS/Linux) or
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

## "⚠ SECURITY: RSCT enforcement is not running in this project"

The scripts under `.rsct/scripts/` are what actually enforce things:
`sanitize-permissions.js` strips permission entries that would let the agent
commit without asking you, and `edit-scope-guard.js` blocks edits outside the
current task's scope. This message means one of them is not doing its job. It
never blocks anything.

The message says which of the two failure modes it found:

- **"`X` is not installed"** — the file is not under `.rsct/scripts/`. Usually
  the project was set up before that script existed, or before the `rsct-mcp`
  companion was installed.
- **"`X` is installed, but no `<event>` entry pointing at it was found"** — the
  file is there, but nothing runs it. A script without its hook enforces exactly
  nothing, which is why this ranks the same as a missing file. Usually a
  `.claude/settings.json` that was reset, hand-edited, or resolved to one side of
  a merge conflict after setup ran.

Fix, for both:

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
- If the message is about registration, `.claude/settings.json` should hold a
  `hooks.SessionStart` entry whose command contains
  `.rsct/scripts/sanitize-permissions.js`, and a `hooks.PreToolUse` entry
  containing `.rsct/scripts/edit-scope-guard.js`. Either one may live in
  `.claude/settings.local.json` instead — RSCT accepts both.

**One blind spot worth knowing.** RSCT only reads this project's
`.claude/settings.json` and `.claude/settings.local.json`. A hook you registered
in your user-level `~/.claude/settings.json` really does run, but RSCT cannot
tell it apart from one registered for a different project, so it reports the
hook as not found here. Moving the entry into the project is the fix; it is also
what lets your teammates get the same enforcement.

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

## "commit message has N non-empty lines; the limit is N"

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

## ".claude/settings.json has changed since this session started"

Not your doing, and RSCT is not blocking anything — it is telling you about a
file that moved on its own.

`.claude/settings.json` is **versioned** (committed, shared with the team), and
Claude Code appends permissions you approve during a session straight into it.
Nobody stages those lines: the agent did not write them, you did not type them,
and the file just accumulates. RSCT records a baseline at session start and
reports any later unstaged divergence at the commit gate, listing the new
entries.

Three ways to resolve it — RSCT will not pick for you:

1. **Stage it with this commit** if the entries belong to the team.
2. **Move machine-specific ones** to `.claude/settings.local.json`, which is
   gitignored. Anything carrying your home path belongs here (§E).
3. **Discard them**: `git checkout -- .claude/settings.json`.

If you see this on every commit and never resolve it, that is the accumulation
the report exists to stop — pick one.

## "the dialog-free commit lane is suspended while RSCT enforcement is not running"

You are on a `trivial`/`small` task that normally commits without a dialog, and
RSCT withheld that. It is not a block: approve the commit per-action with a
`dev_approval` and it lands.

The lane is a privilege granted on the premise that the mechanical layer is
working. When an enforcement script is missing, or is present with no hook wired
to run it, that premise is false — so the next commit falls back to a dialog,
which is the one channel that carries the warning where the agent cannot
summarize it away.

Fix: run `/rsct-setup`, restart the IDE. The lane restores itself; there is no
flag to reset. See the SECURITY section above for how to confirm.

## RSCT never tells me a new release is out

The check is on by default, so silence means one of these — in the order the code
evaluates them:

1. **`RSCT_UPDATE_CHECK` is set** to `off`, `0`, `false` or `no` in the environment.
   This overrides everything else, including `update_check:"on"`. When it is set and
   you ask to turn the check on, RSCT says so rather than claiming an effect it
   cannot deliver.
2. **`~/.rsct/update-check.json` has a `consent` that is not `"yes"`.** Any present
   value other than `"yes"` means off — that is deliberate, so a hand edit cannot
   half-enable it. Installs up to v2.5.1 wrote `"no"` when the setup question went
   unanswered, so you may be opted out without having chosen it. Ask Claude to call
   `rsct_status` with `update_check:"on"`.
3. **You declined that release.** Its tag is in `declined_tags[]` and it will not be
   raised again. A *newer* release asks once more.
4. **The cache cannot be read.** If `~/.rsct/update-check.json` is corrupt, the check
   fails closed and stays silent — deliberately, so an unreadable file can never be
   mistaken for consent. Deleting the file resets it; RSCT recreates it.
5. **It already checked today.** The TTL is 24h.
6. **The result lands on the *next* call.** A stale cache refreshes in the
   background so `rsct_status` adds no latency, so the very first check of a fresh
   install reports nothing.

## Make the update check stop

Ask Claude to call `rsct_status` with `update_check:"off"` — machine-wide and
reversible with `"on"`. For CI, headless runs, or a machine that must never make the
request at all, set `RSCT_UPDATE_CHECK=off` in the environment: it is the only switch
that applies before a session exists. To refuse a single release instead of all of
them, Claude calls `decline_update:"<tag>"`.

If you see *"Decline ignored: … is not the release being offered"*, that is working
as intended: only the release named in the hint can be declined, so a mistyped tag
cannot silently swallow a future security patch. Use the tag exactly as the hint
printed it.

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
