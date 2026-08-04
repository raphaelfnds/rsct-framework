## §E — Mandatory review of credentials and sensitive info exposure

Before any commit, push or output going to the repository, remote, or any
external destination (chat with user, shared log, gist, paste in third-party
tool), always analyze to ensure none of the following is being exposed:

**Credentials and secrets:**
- Tokens, certificates, hashes, decodable JWTs, API keys
- Any string that looks like a secret
- Project-specific sensitive variables (discovered from .env.example and
  application*.properties during setup)

**Local machine information:**
- Absolute paths with OS username (C:\Users\<name>\..., /home/<name>/...)
- Internal hostnames, internal IPs, WSL paths
- Developer workstation identity or topology

**Copied content from other sources:**
- Log excerpts, dumps, terminals from other systems that may contain
  unnoticed confidential info (third-party token, internal IP, query
  with real personal data)

**Real personal data in fixtures, examples or documentation:**
- Real CPF, personal email, real phone number, client name, card data

The .env must be in .gitignore.
The .env.example must have only empty keys or generic placeholders.

How to apply:
- Run `git diff` or `git diff --cached` and inspect visually.
- When in doubt, apply grep with known patterns.
- Mask local paths when showing commands in chat (prefer `<user>` or `~`).
- Any doubt — always stop and ask the user before proceeding.

**`.claude/settings.json` is versioned, and it moves on its own.**

The two settings files are not interchangeable, and the boundary is a §E boundary:

| File | Versioned? | Holds |
|---|---|---|
| `.claude/settings.json` | **yes, committed** | what the whole team should get |
| `.claude/settings.local.json` | no, gitignored | anything specific to THIS machine |

Claude Code appends approved permissions to the **versioned** file during a
session. Nobody decided to version those lines — the agent did not write them and
truthfully says so, and the dev did not either. So the file sits permanently
dirty, and a machine-absolute path with an OS username can land in a committed
file without anyone choosing it. The SessionStart sanitizer relocates the ones it
can recognize; the rest are still a §E judgement call.

A modification you did not author is still yours to resolve. RSCT reports the
divergence at the commit gate and offers three ways out — commit it, move it to
`settings.local.json`, or discard it. It never picks for you: auto-committing
entries nobody reviewed would be worse than leaving them there.

### What RSCT itself sends

One thing, and only when the update check is on: an unauthenticated
`GET api.github.com/repos/raphaelfnds/rsct-framework/releases/latest`,
at most once a day, carrying a `User-Agent` that names rsct-mcp and its
version. No project data, no code, no file names, no telemetry. It is a
suggestion channel — nothing is downloaded or installed.

It runs by default since v2.6.0. `RSCT_UPDATE_CHECK=off` in the
environment disables it outright, and `rsct_status` with
`update_check:"off"` records the same choice for the machine. Nothing
else in the framework opens a network connection: the install-drift
check is a purely local comparison, which is why it lives in a
different module.
