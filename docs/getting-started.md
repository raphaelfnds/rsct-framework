# Getting started

This is the **single-repo (mono) happy path**: install once per machine, restart
your IDE, run `/rsct-setup` in a project. Three steps, one restart. If your
organization spans several repos and you want cross-repo contract governance,
finish this page first, then read [Multi-repo & contracts](multi-repo.md).

## Prerequisites

- **Git** (2.28+ for `git init -b`).
- **Node.js 20+ and npm 10+** — needed for the `rsct-mcp` companion server (the
  mechanical enforcement layer). You can skip it (`--skip-mcp`) and still get the
  passive `CLAUDE.md` rules, but the gates won't be enforced.
- **Claude Code** (VSCode extension, desktop, web, or the CLI). RSCT relies on
  Claude Code reading `CLAUDE.md` and per-project memory at session start.
- **On Windows: Git Bash** — not PowerShell, not WSL. The install scripts are
  POSIX shell and must write to the Windows-side `~/.rsct/` that Claude Code
  reads. See the Windows note in the [root README](../README.md#installation).

## Install (once per machine)

```bash
git clone https://github.com/raphaelfnds/rsct-framework ~/dev/rsct-framework
cd ~/dev/rsct-framework
bash scripts/install.sh
```

The installer copies the runtime to `~/.rsct/`, registers the four `rsct-*`
slash commands, and asks where to register the `rsct-mcp` companion (User scope
is the simplest for a solo dev). For unattended/CI installs and the registration
scopes, see the [root README](../README.md#installation).

## Restart your IDE — the #1 gotcha

Slash commands and MCP servers load **at IDE startup**. After installing (or
after any `claude mcp add`/`remove`), fully close and reopen Claude Code. If you
type `/rsct-setup` and see *"No matching commands"*, that's the symptom — a
restart fixes it.

## Set up a project

From inside any project on the machine:

```
/rsct-setup
```

At a goal level, `/rsct-setup`:

1. **Discovers** your stack (a handful of questions).
2. **Shows you a plan** you must approve before anything is written.
3. **Writes** the governance files (see below).
4. **Offers** — only if relevant — to connect or create an org universe and to
   confirm your repo topology.

It is **idempotent**: re-running detects what already exists and only adds or
updates what changed.

### What `/rsct-setup` writes (in this repo)

| Artifact | What it is |
|---|---|
| `CLAUDE.md` | The governance rules the AI reads at session start. |
| `documentation/` | Architecture, decisions, knowledge, and impact templates you fill over time. |
| `.rsct.json` | Project config — protected branches, topology, the `install` block (the uninstall marker). |
| Memory entries | Under `.claude/projects/.../memory/` — durable facts for the agent. |
| `.claude/settings.local.json` | The SessionStart sanitizer hook (only if you opted into `rsct-mcp`). |

Every artifact carries a reversibility marker, so [`/rsct-uninstall`](commands.md#rsct-uninstall)
can remove it cleanly and SHA256-protect anything you edited by hand.

## First-project walkthrough (5 minutes)

Try RSCT on a throwaway repo before pointing it at production code. If any step
misbehaves, that's a bug worth filing.

1. **Make a sandbox repo:**
   ```bash
   mkdir -p ~/tmp/rsct-trial && cd ~/tmp/rsct-trial
   git init -b main && echo "# trial" > README.md && git add . && git commit -m "init"
   ```
2. **Open it in Claude Code.** If you installed in this session, fully restart
   first (slash commands load at startup).
3. **Run `/rsct-setup`.** Expect a few discovery questions, then a plan to
   approve, then the files above written under your OK.
4. **Ask Claude to commit something.** With `rsct-mcp` installed, Claude proposes
   `rsct_request_commit`. For a `standard`/`complex` task this pops a native OS
   dialog for you to confirm out-of-band before the commit lands; for a
   `trivial`/`small` task it goes through the **dialog-free free-commit lane**
   (bounded by an audit-log-anchored ceiling, with branch-protection and the
   secret-scan still enforced). Either way the audit trail goes to
   `.rsct/audit.log`. Without the companion, a plain `git commit` is refused or
   triggers a reauthorization request per the `CLAUDE.md` rules.
5. **Reverse it.** `/rsct-uninstall` removes everything RSCT added to *this
   project*; `bash ~/dev/rsct-framework/scripts/uninstall-framework.sh` removes
   the framework from the machine.

## What RSCT does to a task

Beyond scaffolding files, RSCT runs every non-trivial change through a fixed
engineering cycle, enforced by the `rsct-mcp` phase tools:

**R → S → V → C → REVIEW → T** — Research → Specification → **Verification** →
Code → **REVIEW** → Test.

- **V (Verification)** audits the *spec/plan* **before** any code is written — a
  reverse-dependency and gap scan against the approved spec.
- **REVIEW** audits the *code/diff* **after** it's written and before tests — a
  correctness / security / regression pass over what actually changed.

They're distinct: V checks the plan, REVIEW checks the diff. At spec-closure RSCT
asks **once** whether to include the code REVIEW; the choice is recorded and
honored — for `standard`/`complex` tasks the Test phase won't start until that
decision is settled (`trivial`/`small` tasks skip it). You don't memorize the
phases; the tools prompt you through them.

The cycle is bracketed by a **plan-tracking gate**: for `standard`/`complex`
tasks the **Code** phase won't start until the plan is written to disk
(`plan_<slug>.md` + `progress_<slug>.md`), so the work stays anchored to an
approved plan. The tools create these at the planning step, so a well-behaved
flow never trips the gate (`trivial`/`small` tasks skip it).

## Next steps

- The full per-command detail → [Command reference](commands.md).
- Want a duplication / scalability / dependency sweep before refactoring →
  [`/rsct-clean-code`](commands.md#rsct-clean-code).
- More than one repo in your org? The universe, topology modes, contracts, and
  [which session edits which repo](multi-repo.md#which-session-edits-which-repo)
  → [Multi-repo & contracts](multi-repo.md).
- Something not working → [Troubleshooting](troubleshooting.md).
