<!-- RSCT-GENERATED v=1.0.0 created=[CREATED_AT] sha256-body=[SHA_PLACEHOLDER] -->
name: Secrets and sensitive info leak prevention
description: Before commit/push/external output, review credentials, local paths, personal data, and content copied from logs or other terminals
type: feedback

Before any commit, push, or external output, verify absence of:
project-specific variables (DB_PASSWORD, JWT_SECRET, MAIL_PASSWORD,
API_KEY_*, etc.); any token, certificate, hash, decodable JWT, or
secret-looking string; absolute paths with OS username (C:\Users\<name>\...,
/home/<name>/...); internal hostnames, IPs, WSL paths; real personal data
(CPF, email, phone, client name, card data); content copied from logs or
other system terminals.
The `.env` must be in `.gitignore`. The `.env.example` must contain only
empty keys or generic placeholders.

Why: Leaked credentials trigger incidents and force rotation; leaked personal
data violates LGPD/GDPR; output is irreversible once external.
Ref.: §E of CLAUDE.md.

How to apply: Run `git diff --cached` before commit, grep for known patterns,
inspect visually. In any doubt — stop and ask the user. Same check applies
to any text about to leave the local environment (chat output, issue
comments, PR descriptions).
