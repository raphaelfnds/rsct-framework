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
   `where rsct-mcp` (Windows). If it prints nothing, re-run the installer
   (`bash scripts/install.sh`, answer **Y** to the companion). It says whether the
   `rsct-mcp` on PATH is the copy it placed in `~/.rsct/mcp-server` and whether it
   started.
5. Confirm it boots: `rsct-mcp < /dev/null` (Git Bash/macOS/Linux) or
   `cmd /c "rsct-mcp < NUL"` (PowerShell) should print a one-line ready log on
   stderr and exit cleanly.

If the tools were there before and vanished, the global `rsct-mcp` command may
still be linked to a clone that has since moved or switched branch (how the
companion was installed before it got its own folder), or `~/.rsct/mcp-server` may
have been removed by hand. Re-run the installer: it puts a fresh copy there and
links the command to it.

## "This project was set up with RSCT vX; the installed rsct-mcp is vY"

An **install-drift** notice: the framework in this project is older than the
`rsct-mcp` binary running against it, so newer rules, prompts and markers are not
applied here yet. It is a suggestion, never a block.

Fix: re-run `/rsct-setup` in the project. Nothing is lost — setup is idempotent
and preserves your answers.

## "⚠ SECURITY: RSCT enforcement is not running in this project"

The scripts under `.rsct/scripts/` are what actually enforce things:
`sanitize-permissions.js` strips permission entries that would let the agent
commit without asking you, `edit-scope-guard.js` blocks edits outside the
current task's scope, and `terminal-guard.js` refuses a `git commit`, `push`,
`merge`, `rebase`, `cherry-pick`, `revert`, `am` or `gh pr merge` the agent runs
in its own terminal. This message means one
of them is not doing its job. It never blocks anything.

The message says which failure mode it found:

- **"every Claude Code hook is switched off ("disableAllHooks": true in …)"** —
  a settings file turns every hook off, the three RSCT ones included. Claude Code
  reads `.claude/settings.local.json` first, then `.claude/settings.json`, then
  `~/.claude/settings.json` (RSCT does not read a user folder moved with
  `CLAUDE_CONFIG_DIR`); the message names the file whose value wins. Remove
  the setting yourself and restart the IDE.
- **"`X` is installed, but its hook entry is not in the form this rsct-mcp
  installs"** — the entry exists but its matcher or command differs from the one
  `/rsct-setup` writes. Every project set up with 2.13.0 to 2.14.1 shows this for
  `edit-scope-guard.js` until `/rsct-setup` runs again, because the command
  gained `NODE_OPTIONS=` and `|| exit 2`; any other time it means the entry was
  edited.

- **"`X` is not installed"** — the file is not under `.rsct/scripts/`. Usually
  the project was set up before that script existed, or before the `rsct-mcp`
  companion was installed. If a guard's hook entry is still there, every edit or
  every terminal command it covers is refused — see "Every terminal command, or
  every edit, is refused" below.
- **"`X` is installed, but no `<event>` entry pointing at it was found"** — the
  file is there, but nothing runs it. A script without its hook enforces exactly
  nothing, which is why this ranks the same as a missing file. Usually a
  `.claude/settings.json` that was reset, hand-edited, or resolved to one side of
  a merge conflict after setup ran.
- **"`edit-scope-guard.js` is installed, but it is a build that cannot block an
  edit"** — the project holds a copy written by `rsct-mcp` 2.2.0 to 2.12.3.
  Every one of those builds exited before reaching its own check, so the edit
  guard never refused an edit in any project set up with them. Every project
  installed before the fix shows this until `/rsct-setup` is run again.

Fix, for all but the first:

1. Run `/rsct-setup` — it installs the scripts and registers their hooks. It
   also replaces a guard entry in any other form with the one it installs (the
   commands older setups registered without quotes were split by the shell in a
   project whose path contains a space, and no hook ran there).
2. **Fully restart the IDE.** The running server compares against the copy it
   ships; until it restarts you may still see the old message.
3. Confirm with `rsct_status` that the message is gone.

If it survives that:

- `ls .rsct/scripts/` should list `sanitize-permissions.js`,
  `edit-scope-guard.js`, `terminal-guard.js` and a small `package.json`. If they are missing,
  `/rsct-setup` could not find the `rsct-mcp` companion to copy them from — it
  takes them only through the link the installer creates in `npm root -g`, so a
  server registered by absolute path, run via `npx`, or present there as a plain
  folder is not used. Run the installer (`bash scripts/install.sh`, with
  `--wsl` when Claude Code itself runs inside WSL) and re-run `/rsct-setup`.
- If the message is about registration, `.claude/settings.json` should hold a
  `hooks.SessionStart` entry whose command contains
  `.rsct/scripts/sanitize-permissions.js`, and two `hooks.PreToolUse` entries:
  matcher `^(Edit|Write|MultiEdit|NotebookEdit)$` with
  `NODE_OPTIONS= node "${CLAUDE_PROJECT_DIR}/.rsct/scripts/edit-scope-guard.js" || exit 2`,
  and matcher `^(Bash|PowerShell|Monitor)$` with the same command for
  `terminal-guard.js`. Any of them may live in `.claude/settings.local.json`
  instead — RSCT accepts both.

**While the message is up** the commit, push, merge, rebase and
batch-authorization dialogs carry a warning line, and each of those calls — and
each `rsct_load_context` — adds one `install.drift_detected` line to the audit
log. Nothing is refused.

**What the edit guard does once it runs.** Two refusals, for `Edit`, `Write`,
`MultiEdit` and `NotebookEdit`:

- After a plan closes, **every** edit is refused, whatever the path, until the
  context is reloaded (`rsct_load_context`; `rsct_status` alone does not clear
  it).
- Otherwise, while a phase has declared a list of files (`scope_globs`), an edit
  outside that list is refused. The list is matched against the path below the
  project root; entries are relative to it and compared, case-sensitively, with
  the resolved spelling — the refusal names the path it judged, which is
  the place to look when an entry "should have matched" (on Windows and macOS
  that is the on-disk spelling; inside WSL on `/mnt/c` it is the spelling you
  typed, so match the case there). Three things are let
  through here:
  the plan-tracking files at the project root (`plan_*.md`, `progress_*.md`,
  `spec_*.md`), a path outside the project, and everything when no phase has
  declared a list.

It does not watch the terminal: a shell command that writes a file is not seen.
In a project the framework does not manage — no `.rsct.json`, or one it
rejected — the guard lets scope through, while `rsct_check_edit_scope` still
answers from the recorded list. Two refusals hold everywhere: a Claude Code
settings write that would switch every hook off, change or remove an RSCT hook entry, leave such a file unparseable, or add,
change or remove any `env` entry (`claude_settings` — make that edit yourself; since 2.23.0 every key, not only
`NODE_OPTIONS`, `PATH` or `BASH_ENV`),
an edit of `.rsct.json` that sets `database_guard` or `database_test_guard` to
`false` (`rsct_config`, since 2.22.0 — make that edit yourself), an `Edit` of
either file whose old text is not in the file exactly as written (since 2.22.0 —
the guard cannot tell what it would write; quote the file exactly),
and a fault inside the guard (`guard_failed` — the edit did not run; make it
yourself, and if every edit is refused see "Every terminal command, or every
edit, is refused" below).

One refusal can surprise on Windows: a network-style path (`\\server\share\…`)
on a different host than the project is refused while a list is active, because
the guard cannot tell it apart from a path that points back into the project.
Use the file's path under the project root, or a path on a local drive.

**Every edit is refused with `stale_context` and there is no `rsct_load_context`
to call.** The guard is a file in the project and works without the server; the
flag it reads (`context_stale` in `.rsct/phase-state.json`) can only be cleared
by the server. So a project whose last plan was closed keeps refusing edits when
`rsct-mcp` is not connected in the session, or was removed from the machine with
`scripts/uninstall-framework.sh` while the project kept its hooks. Two ways out:

- You still use the framework: install or reconnect `rsct-mcp` (run the
  installer, restart the IDE) and let the session call `rsct_load_context`.
- You do not: remove the entries whose command contains `.rsct/scripts/`
  from `hooks` in `.claude/settings.json` (and `.claude/settings.local.json`, if
  they are there), then delete `.rsct/scripts/` — in that order: a guard entry
  left without its script refuses every edit, or every terminal command.

## "[rsct] Terminal command blocked"

The terminal guard refused a command the agent ran through its Bash, PowerShell
or Monitor tool. The message names the reason:

- **A git or GitHub command that goes around an approval** — `git commit`,
  `push`, `merge`, `rebase`, `cherry-pick`, `revert`, `am`, `gh pr merge`,
  however it was written (`env git`, `git -C`, `bash -c "…"`, `wsl …`, an alias,
  a `node -e` that calls git). The agent should call the RSCT tool the message
  names, which shows you the approval dialog. If you want the command done by
  hand, run it yourself in your own terminal: the guard sees only the agent's
  tools. `--abort`, `--quit`, `--continue` and `--skip` of merge, rebase,
  cherry-pick, revert and am pass when nothing else follows the verb
  (`git merge -m --abort x` is a merge, and is refused). Since 2.17.0 the guard
  also refuses `git commit-tree`, `filter-branch`, `fast-import`, `quiltimport`
  and `replay`, and every `git pull` except `git pull --ff-only` with plain
  options (`-q`, `-v`, `--prune`, `--tags`…), every word written out, from a
  repository not spelled as a path (`.`, `../x`, `/x`, `C:…`, `file:`);
  `git fetch` passes. A pull that would merge or rebase is yours to run.
- **"a command name built from a variable, a substitution or a brace or glob
  pattern …"** — the guard cannot tell which program `"$G" commit` runs; write
  the program name out. **"a command run from an unquoted variable,
  substitution or brace or glob pattern …"** — the shell splits `$C` or
  `{git,commit}` into a whole command line; write the program name out, or
  quote the variable when it holds only a program path (`"$PY" script.py`).
  **"a git subcommand built from …"**, **"a gh subcommand built from …"**
  (also `git co$X`, `git {commit,}`, `git [c]ommit`),
  **"Invoke-Expression with code built from a variable …"**, **"a PowerShell
  command built from a variable …"** and **"code passed to … from a variable
  or a substitution …"** — the same: the guard cannot read what will run;
  write the command out.
- **"a gh alias that runs `gh pr merge` or a refused git verb is refused"** —
  the alias would merge or commit outside the approval; the developer merges
  on GitHub or in their own terminal.
- **"the git alias '…' could not be resolved"** — the guard asks git what the
  alias means and git failed or did not answer in 3 seconds; **"… expands
  through too many other aliases"** — the alias is one of a chain of more than
  five. Either way, use the full command.
- **"a command that mentions disableAllHooks"** — switching Claude Code hooks
  off is your edit, not the agent's.
- **"… so it is refused from the terminal: the developer runs it in their own
  terminal where a database change is their decision"** (since 2.22.0) — the
  command changes a database, or the guard cannot read what it would run: a
  client statement that writes, a statement from a file, stdin, a pipe or a
  variable, a migration, seed, reset, wipe or restore, a console fed from a pipe,
  a volume removal. Run it yourself if you mean it. A read-only form passes
  (`psql -c "select …"`, `migrate:status`, `--sql`), so the agent can check
  state without you. To switch these rules off in a project, set
  `database_guard: false` in `.rsct.json` yourself.
- **"this Laravel test run is refused: the guard cannot confirm it uses a
  throwaway test database …"** — a test suite with `RefreshDatabase` recreates
  whatever database it connects to. Add to the `<php>` block of the
  `phpunit.xml` PHPUnit loads:
  `<env name="DB_CONNECTION" value="sqlite" force="true"/>` and
  `<env name="DB_DATABASE" value=":memory:" force="true"/>` (or force a
  database whose name is a test one, such as `app_test`). Only `force="true"`
  counts: without it a value from your environment wins, and `.env.testing` is
  not read for the same reason. The message names the lines set without
  `force="true"`, a `DB_URL`/`DATABASE_URL` in `.env` that would override them,
  or `--no-configuration`. `php artisan dusk` is always refused (Dusk swaps in
  its own environment file). To switch only this check off, set
  `database_test_guard: false` in `.rsct.json` yourself.
- **"a command that mentions database_guard or database_test_guard"** —
  switching the database rules off is your edit of `.rsct.json`, not the
  agent's.
- **"'…' here would run commands it reads from a pipe or from another command's
  output"** (since 2.22.0) — `… | sh`, `curl … | bash`, `… | iex`; the guard
  cannot read piped code. Write the commands out.
- **"the package.json script '…' that this command runs is refused"** (since
  2.22.0) — the script `npm run`, `yarn`, `pnpm`, `bun` or `composer` would run
  does something the guard refuses; the reason follows. Run it yourself, or call
  the RSCT tool for the git step.
- **"a command over 64 KiB is refused"**, **"a single command with more than
  2048 words is refused"**, **"could not finish judging this command in time"**
  (since 2.22.0) — write long input to a file with the Write tool and run a short
  command.
- **"the command nests shells or substitutions too deeply to be read"** — more
  than eight levels of shells, substitutions or `Start-Process`; write it out
  plainly. **"could not read the tool call"**, **"names no tool"**, **"carries
  no command text"** — the call itself was malformed; nothing ran.
- **"the terminal guard failed (…), so nothing ran"** — the guard itself broke
  on that command. Run what you need in your own terminal; if every command is
  refused, see below.

**Every terminal command, or every edit, is refused.** A guard that cannot run
blocks rather than lets everything through: its entry ends in `|| exit 2` on
purpose. The usual causes are a script missing from `.rsct/scripts/` (deleted,
or cleaned away before it was committed), a machine where `node` is not on the
PATH Claude Code gives its hooks (a teammate who has Claude Code but not Node),
or a guard that breaks on every call (`guard_failed`, "the terminal guard
failed"). When the script or Node is missing, the message is Node's or the
shell's own error, not an `[rsct]` line.

The agent cannot repair this: its commands go through the same guard, and the
edit guard refuses a settings edit that changes or removes an RSCT hook. Repair it
yourself:

1. In your own editor, remove the `hooks.PreToolUse` entries whose command
   contains `.rsct/scripts/` from `.claude/settings.json` (and
   `.claude/settings.local.json`, if they are there). If only the scripts are
   missing and they are committed, `git checkout -- .rsct/scripts` in your own
   terminal restores them instead.
2. Run `/rsct-setup` again. It installs the scripts and registers the entries.

If the guard breaks on every call even after that, `/rsct-setup` has put the
same build back: leave the entry out, update `rsct-mcp` with the installer, and
report it as an issue. On a machine without Node, install Node: the guards
need it to run. When
removing RSCT from a project, take the entries out first, then delete
`.rsct/scripts/`.

**Windows without Git Bash.** Claude Code then runs hook commands in
PowerShell (from the documentation; not measured). Windows PowerShell 5.1 cannot
parse `NODE_OPTIONS= node … || exit 2`, so the guards would not run and
`rsct_status` cannot tell; PowerShell 7 runs it as an unknown command, so every
edit and every terminal command would be refused. Install Git for Windows.

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
  push the scripts backwards. With an `rsct-mcp` of 2.12.3 or older, "backwards"
  means back to an edit guard that cannot block.
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

## A commit is refused with `secrets_unreadable`, `staged_paths_unreadable`, `staged_state_unreadable` or `staged_changed`

Since 2.23.0 `rsct_request_commit` reads exactly what git is about to commit and refuses a commit
it could not read, instead of letting it through unchecked (ADR-039, ADR-040). Nothing was
committed.

- **`secrets_unreadable`, `staged_paths_unreadable`, `staged_state_unreadable`**: git failed, did
  not answer in time (120 s for the secrets scan, 30 s for the list of staged paths and for the
  staged tree, HEAD and branch), or could not tell whether the folder is a repository. The reason
  quotes git when it said something. Another git process holding `.git/index.lock` is waited for
  about a second before `staged_state_unreadable`.
  - Retry once.
  - If one very large file keeps failing the read, split the commit.
  - Otherwise commit that change by hand in your own terminal.
- **`staged_changed`**: what is staged, HEAD or the branch changed between the approval dialog and
  the commit, or the branch changed while the commit was being prepared. Something ran `git add`,
  `git commit`, a checkout or a branch switch meanwhile. Look at
  `git status` and ask again, so the dialog shows what will be committed.

## A commit returns `committed_with_drift`

The commit that landed is not exactly what you approved. Its tree or parent differs from the one
recorded before the dialog — most likely a git `pre-commit` hook that staged more or rewrote a
file. The hints list the paths that changed and how many secret findings they carry, and the audit
log records `request_commit.tree_drift`.

- Check those paths in the commit (`git show --stat HEAD`) before any push.
- To take the commit back, `git reset --soft HEAD~1` undoes it and keeps everything staged (on a
  first commit, `git update-ref -d HEAD`).
- If the hints say the commit landed on another branch, a hook switched the branch during the
  commit: find the commit (`git log --all --oneline -3`) and undo it on the branch that has it.
- If a code file the hook changed is among them, the next commit is refused with `review_drift`
  until `rsct_phase_review_start` / `_complete` covers it. Other files (a README, a JSON file) are
  reported only: a REVIEW stamps code files, so it could not clear a lock on them.
- A hook that only reformats code files the REVIEW already accepts does not trigger the lock.
- The same status, with "RSCT could not compare the commit", means git committed but RSCT could
  not read the commit back. Check it the same way.

## A commit returns `mutation_failed` and says HEAD moved

`git commit` reported a failure, but HEAD now points at a commit RSCT did not check. Either a
`pre-commit` hook ran its own `git commit` (git then refuses the outer commit with `cannot lock
ref 'HEAD'`), or git created this commit and failed afterwards. The audit entry carries
`head_moved_to`. The approval counts as used and a plan token's action is not refunded.

- Look at that commit (`git show <sha>`) before any push.
- To take it back, `git reset --soft HEAD~1` keeps its changes staged (on a first commit,
  `git update-ref -d HEAD`).
- Then fix or remove the hook, and ask for the commit again with a fresh approval.
- If the hint says HEAD now points at another branch, nothing was committed: a hook switched the
  branch and git refused the commit. Switch back (`git switch <branch>`) and do not run the reset.

## The first commit of a new repository is refused with `protected_branch`

Since 2.23.0 the branch is known before its first commit, so a first commit on `main` (or any
protected branch) needs the protected-branch exception, like every other commit there. Approve it
in the dialog, or start on a feature branch.

## A commit, push, merge or rebase is refused with `force_dialog_no_channel`

Since 2.17.0 these four always need you in the OS dialog, and so does minting a
batch token (`rsct_plan_authorize`). On a machine where no dialog can open — Linux
without `/usr/bin/zenity`, a Windows session with no desktop — they are refused,
whatever `approval_modes.trust_allowed_for` lists: those names still load and have no
effect. Run the command yourself in your own terminal.

## A request is refused with `dialog_failed`

The dialog program started but ended without a Yes or No: it failed, or it was
closed some other way. Since 2.20.1 that is a refusal for every tool, and
`approval_modes.trust_allowed_for` never applies to it — only a dialog program that
is not installed, a system with no supported dialog program, or a Windows session
with no desktop counts as "no dialog". It is not recorded as your decision: a phase
closed on its own stays pending, and the REVIEW's unverified-files question stays
undecided (at `rsct_phase_code_start` the audit line is `run_alone.declined` with
`reject_kind: dialog_failed`, as for a missing channel). Common causes:
- Linux with zenity installed but no display (an SSH session, a container): run from
  a desktop session, or let the developer answer from one.
- macOS with no GUI session (SSH): the same.
- Windows where PowerShell is restricted (for example Constrained Language mode under
  an application-control policy), or where the dialog program cannot start.

The reason in the reply says what the dialog program reported.

## The batch token is refused or does not count

- **`not_multi_phase`** — the token is only for a plan with two or more phases:
  list them in the `## Phases & parallelization` table of `plan_<slug>.md` (a row
  needs a Phase and a Goal that are filled in, not `<TODO>`). A single-phase plan
  commits with a dialog each time.
- **`no_active_plan`** — no `plan_<slug>.md` at the project root (a `spec_` file
  is not taken as the plan), or `plan_slug` names a file that is not there.
- **`plan_token_invalid` … expired** — a token lives 8 hours at most from your
  approval and a commit never extends it; a token an older version minted is held
  to the same 8 hours. Authorize again.
- **`plan_token_invalid` … no `plan_authorize.authorized` line** — the audit log
  does not show the approval that minted this token (it was written by hand, or the
  log was edited). Authorize again.

## ".rsct/phase-state.json could not be read … nothing was overwritten"

The file that holds the active phase, the REVIEW ledger, the plan token and the
commit locks is not valid JSON — a hand edit, a merge-conflict marker, a
truncated copy. RSCT refuses to replace it, and says so instead of answering as
if the file were empty:

- `rsct_request_commit` rejects **every** commit, docs-only included
  (`review_unreadable`), before asking you to approve anything;
- `rsct_plan_authorize` mints no token and does not spend the approval;
- `rsct_plan_revoke`, `rsct_phase_abandon`, the `rsct_phase_*_start` tools and
  the tier record of `rsct_classify_task` stop the same way. One exception:
  `rsct_phase_code_start` runs its own gates first and answers with what they
  find missing — a classify verdict, a plan, a completed verification — without
  naming the file; the tool that answer points to names it.

Nothing was committed and the state file was not touched (each refusal adds a
line to `.rsct/audit.log`). Two ways out:

1. **Repair the JSON.** Everything the file recorded comes back.
2. **Delete the file.** RSCT starts from a clean state — and that drops what the
   file recorded: the REVIEW ledger (staged code needs a REVIEW again), an active
   plan token, the tier recorded by `rsct_classify_task`, a `review_drift`
   lock if one was armed, kept dead-code decisions, and a `run_alone` record with the phases the agent
   closed on its own and you have not approved yet (the next REVIEW then asks
   for none of them). Before deleting, look at `.rsct/audit.log`: a recent
   `review.commit_drift` line names code that landed without a review, and that
   lock will not come back on its own — run a REVIEW over those paths.

Since 2.18.0 the message — and the hints of `rsct_load_context` and
`rsct_status` for the same file — asks the agent to stop and ask you; deciding
between the two is yours.
An empty file is not corruption; RSCT writes over it.

## "`.rsct.json` audit.path (…) … was ignored — the audit log stays at …"

Since 2.18.0 a configured `audit.path` that no file can sit at is ignored, the
same way as one that points outside the project: a value with a control
character, one that names a folder or goes through a file, and on Windows one
that names a stream inside a file (a `:` after the drive), holds `< > " | ? *`,
a reserved device name such as `NUL` or `CON`, or ends in a dot or a space. The
log stays at `.rsct/audit.log`, where you can open it, and the tool hints quote
the value. Fix or remove `audit.path` in `.rsct.json`. While the value names a
stream, the ten-day cut leaves every log alone, so what the old setting wrote
into that stream is kept until you move it out.

## `.rsct/audit.log` is shorter than it used to be

That is the retention rule, not a fault. Since 2.14.0, about once a day a commit that
lands removes the entries older than 10 days — phase starts and completions,
findings, commits, pushes, merges and refusals. Kept whatever their age: the entries
a gate can still use, the entries named as an override, a skip, a degraded check or a
bypass, and the newest of each repeating state record (a rejected config, enforcement
not running, the settings baseline, a skipped settings migration). The file is the
only copy: nothing removed can be brought back.

The first commit that lands after upgrading from an older version does the first
cut, which can remove months at once. When a cut reaches entries more than 20 days
old, the approval dialog says how many lines are due before you answer; a log that
does not go back that far is cut without that line. No dialog is shown for a commit
under a plan token, so nothing warns beforehand there either. Afterwards the
tool's hints report the cut, and an `audit.pruned` entry carries the count, the cutoff
and a running total. Want the old history? Copy the file before that commit. A
refused or declined commit removes nothing.

Not cut, and the hints say so: a project on a volume without hard links (one reached
from Windows through `//wsl.localhost/`) or on a 9p share, where replacing a file is
not atomic (a Windows disk reached from inside WSL, `/mnt/c`), a log over 512 MB, a log
path that is not a regular file. Not cut, and nothing says so: a project whose `.rsct.json` is
rejected. The full rule is under "Audit log" in `mcp-server/README.md`.

`.rsct/reports/audit-prune.lock`, `audit-prune-new.log` or `audit-prune-old.log` left
behind means a cut was interrupted. Leave them: a commit that lands once the lock is
a minute old finishes or undoes it (a younger lock is a cut in progress), and the
commit after that one cuts.

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

## The installer or uninstaller stops under WSL

- **"This script is running under WSL"** — without `--wsl` the scripts refuse to run
  inside WSL. If your Claude Code runs on Windows, run them from Git Bash instead. If
  it runs inside this WSL distro, add `--wsl`.
- **"--wsl was given, but this is not WSL"** — `--wsl` is only for a shell inside a
  WSL distro. On Windows (Git Bash), Linux or macOS run the script without it.
- **"--wsl: no Claude Code CLI ('claude') was found inside WSL"** — no `claude` is
  installed inside WSL (the message also names the Windows one when there is one).
  Install Claude Code's CLI inside WSL first, or, if the Windows Claude Code is the one
  you use, install from Git Bash without `--wsl`.
- **"--wsl: '…' at … is a Windows program, or could not be checked"** — `node`, `npm` or
  `claude` resolved to a Windows program sitting in a Linux folder, to a link into
  `/mnt/c`, or to a file that cannot be read. Install a readable Linux one there instead.
- **"--wsl: no folder on PATH could be confirmed to be on WSL's Linux side"** —
  `wslpath` gave no Linux answer for any PATH folder, so no program could be trusted.
  Run the script from a normal shell inside the distro.
- **"--wsl: 'npm prefix -g' gave no folder"** — npm is installed but did not say where
  its global folder is, so it could not be checked. Fix npm inside WSL and run again.
- **"--wsl: … is not on WSL's Linux side, or could not be checked"** — a folder or file
  the script would touch (`~/.rsct`, `~/.claude/commands`, Claude Code's config file or folder,
  npm's global folder) lives on `/mnt/c/...` (or is a link there), usually because
  `HOME`, `CLAUDE_CONFIG_DIR` or npm's prefix points there; a relative path, a path with
  a `.` or `..` segment, or a link whose target is gone cannot be checked either. Touching
  it could change the Windows install, so nothing was written or removed. Point them at
  the Linux disk, as plain paths, and run again.
- **"--wsl needs /usr/bin/wslpath"** — the shell shares the WSL kernel but is not a
  WSL distro (a container, for example). Run the script inside the distro itself.
- **"this shell 'rsct-mcp' still resolves to the Windows one"** — the companion was
  installed inside WSL, but the Windows `rsct-mcp` comes first on PATH, so a Claude
  Code inside WSL would start the Windows one. Nothing was registered. Put the Linux
  folder the message names ahead of the `/mnt/` folders on PATH and run the installer
  again with `--wsl`.

## The uninstaller says the user-scope registration "is still in place"

It found `rsct` registered at user scope in Claude Code's config file but did not
remove it: no `claude` CLI was on PATH, the entry was still in the file after
`claude mcp remove`, or you chose to keep it (`--skip-mcp`, or answering `n`). When the
file could no longer be read after the removal, the closing line says "Not confirmed"
instead. The message names the file. Run `claude mcp remove rsct --scope user` (inside
WSL, use the full path of the Linux `claude` when the message shows one, never a bare
`claude` that may be the Windows one), or delete the `"rsct"` key under `"mcpServers"` in
that file, then restart Claude Code. When the closing line says "Not checked", node was
not on PATH, so the file could not be read: look for the key yourself.

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

## Uninstall says `.rsct.json` has no `install` block

Without that block nothing records what setup changed, so `/rsct-uninstall` removes
nothing. It lists, read-only, what an earlier install left: RSCT lines in `CLAUDE.md`,
generated files in `documentation/`, files in `.rsct/`, hook entries, the `.gitignore`
block. This happens on a project set up before 1.0.0, on one whose `.rsct.json` was
edited or deleted, and on one already uninstalled by a version before 2.20.0, which
left the `CLAUDE.md` header lines and the conventions pointer behind.

Run `/rsct-setup`, then `/rsct-uninstall`. Setup adopts what is there — a `CLAUDE.md`
with your text is updated in place, never replaced — and the uninstall then removes
the framework parts, the old leftovers included. A `CLAUDE.md` that held nothing but
those leftovers is deleted; one with your text is kept. Or clean up by hand with the
steps at the end of `prompts/03-uninstall.md`.

## Uninstall kept `CLAUDE.md`

The uninstall deletes `CLAUDE.md` only when git shows that setup created it — no
`CLAUDE.md` at the commit recorded in `install.setup_commit_sha_before`, or one with
only framework text — and nothing but framework text is left. The report gives the
reason when it keeps the file:
- **"git cannot prove setup created it"** — the recorded commit is `INITIAL` (the
  repository had no commit at setup) or no longer exists here. Delete the file
  yourself if you want it gone.
- **"your text is in it"** / **"you had a CLAUDE.md before setup"** — it is your file.
- **"RSCT text you kept is still in it"** — a section left out of the uninstall scope,
  or a conventions pointer you edited.

What can stay in a kept file: the lines the CREATE template writes with no marker
(`# CLAUDE.md — <app>`, two intro lines, `---`), and the body of a section that was
your own text (`hand-merged`, `migrated-from-ptbr-preserved`).

## Uninstall offers to restore `CLAUDE.md` from git

Versions before 2.20.0 routed a `CLAUDE.md` that had your text but no RSCT rules to
CREATE mode, which replaced it with the template. When git still has your file at the
commit recorded before that setup, the uninstall offers to put it back
(`git checkout <commit> -- CLAUDE.md`). Answer `keep` to leave the current file. Since
2.20.0 setup refuses to create over a `CLAUDE.md` that has content.

## `.rsct/audit.log` shows up in `git status` of a monorepo or worktree

In a linked git worktree, a monorepo package or a project inside another repository,
`rsct-mcp` writes the audit log and the approval store into the `.rsct/` folder of the
repository (the main worktree, or the repository root) — outside the project's own
`.gitignore`. Since 2.20.0 the server writes a `.rsct/.gitignore` there the first time
it writes one of those files, so new files stay out of git. Files that versions 2.9.0
to 2.19.x left there and that were **committed** stay tracked; untrack them once, from
the repository root:

```bash
git rm --cached --ignore-unmatch .rsct/audit.log .rsct/approvals-seen.json
git rm -r --cached --ignore-unmatch .rsct/reports
```

Then commit. The files stay on disk. `/rsct-uninstall` never removes that folder: it
is shared by every RSCT project of the repository, and removing it would reset their
approval store and audit history.

---

See also: [Getting started](getting-started.md) ·
[Command reference](commands.md) · [Multi-repo & contracts](multi-repo.md).
