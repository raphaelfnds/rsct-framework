# RSCT documentation

End-user documentation for the RSCT Framework. Start with **Getting started**;
reach for the others as you need them.

| Doc | What it covers | Read it when |
|---|---|---|
| [Getting started](getting-started.md) | Prerequisites, install, restart, `/rsct-setup`, what gets written, a 5-minute first-project walkthrough. The **single-repo (mono) happy path** — near-zero config. | You are setting RSCT up for the first time. |
| [Command reference](commands.md) | A per-command manual for the four slash commands (`/rsct-setup`, `/rsct-init-universe`, `/rsct-canonical-source`, `/rsct-uninstall`): purpose, preconditions, what each does, outputs, consent gates, recovery. | You want the full detail on one command. |
| [Multi-repo & contracts](multi-repo.md) | The T2 layer: the app ↔ org-universe model, topology modes, the universe repo, contracts & surfaces, **producer-vs-consumer** (the gate is producer-side), and a step-by-step multi-repo walkthrough. | Your organization has more than one repo and you want cross-repo contract governance. |
| [Troubleshooting](troubleshooting.md) | Common failures and their fixes — command not found, the MCP server not connecting, the contract gate firing (or not) when you expected. | Something didn't behave as the docs describe. |

For the companion MCP server's tool-by-tool reference (the field-level detail —
exact tool inputs/outputs, the `topology`/`universe` block schemas, the contract
graph), see [`../mcp-server/README.md`](../mcp-server/README.md). These user docs
link into it rather than restate it, so there is a single source for the
field-level facts.

> The internal contributor notes (anti-patterns, cross-OS rules, design history)
> live in [`../CLAUDE.md`](../CLAUDE.md) — that file is for people working *on*
> the framework, not *with* it.
