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
