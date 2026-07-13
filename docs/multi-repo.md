# Multi-repo & contracts

This is the **opt-in guided flow** for organizations whose code spans more than
one repository. It explains the model and the workflow; for the field-level
reference (exact tool inputs/outputs and the `topology`/contract-graph schemas)
this page links into the companion server's docs rather than restating them:
see [`rsct_get_topology`](../mcp-server/README.md#rsct_get_topology) and
[the `topology` block](../mcp-server/README.md#the-topology-block).

> Single repo? You don't need any of this — [Getting started](getting-started.md)
> is the whole story. Topology stays `mono` and no contract gate ever fires.

## The three layers

| Layer | What lives there | Who edits it |
|---|---|---|
| **App repo** | Your application + its `CLAUDE.md`, `documentation/`, `.rsct.json`. | The app's developers, in the app session. |
| **Org universe** | One repo per organization: governance docs, the `applications/` registry, and `contracts.json`. Marked by a `.universe.json` file. | The org owner, **by hand**, committed from the universe's own session. |
| **The link** | Each app repo points at the universe as its *canonical architectural source* (added by [`/rsct-universe`](commands.md#rsct-universe)). | Written into the app repo. |

## Which session edits which repo

A recurring point of confusion: **the app session and the universe live in
different repos, and RSCT never commits to the universe for you.**

- Running `/rsct-setup` / `/rsct-universe` in an **app repo** edits *that
  app repo* (its `CLAUDE.md`, `.rsct.json`).
- Registering the app or declaring a contract writes **working files into the
  universe repo** — but RSCT does **not** run git there. You open the universe
  repo yourself, review the changes, and commit them.
- `contracts.json` and `.universe.json` are **hand-owned** files in the universe.
  RSCT scaffolds and guides them; it never invents their content and never
  commits them.

So the rule of thumb: *app changes commit from the app session; universe changes
you review and commit from the universe repo yourself.*

## Topology modes

Your repo topology is one of three modes. RSCT infers a likely mode from signals,
but the **mode that matters is the one you confirm** at `/rsct-setup` — it is
persisted to `.rsct.json` (`topology.mode`) and is what every gate reads.

| Mode | Plain meaning | Contract gate |
|---|---|---|
| `mono` | One app, one repo. | Never fires. |
| `monorepo` | Several apps in one repo. | Never fires. Inference here is heuristic/low-confidence (it depends on your folder layout) and only **pre-selects** the topology question — it never gates on its own. |
| `multi-repo` | Several apps, one repo each, sharing an org universe. | Can fire — producer-side only (see below). |

## The universe repo

A repository is a universe when it contains a **`.universe.json`** marker. Inside
it, the `applications/` directory is the **registry ground truth** — one folder
per registered app; the `registered_apps[]` array in `.universe.json` is just an
index of the same set.

An app finds its universe through this resolution order:

1. An explicit path in the app's `.rsct.json` (`universe.local`).
2. A **sibling probe**: `../<name>-universe` next to the app repo. The name tried
   is your universe name, then your org name **with a trailing `-<digits>`
   suffix stripped**, then the raw org name. So an app in a directory like
   `acme-23` resolves a sibling `acme-universe` — the numeric suffix is
   normalized away. A bare `../universe` is also tried.
3. Common workspace homes (`~/projects/<name>-universe`, `~/dev/…`, etc.).

If a configured universe path is set but missing, that is reported (the link is
broken, not silently ignored).

## Contracts & surfaces

A **contract** declares that one app exposes a **surface** that other apps
depend on. Each entry has this shape:

```json
{
  "id": "erp-client-csv",
  "producer": "api-python-client",
  "surface": ["openapi/*.yaml", "src/api/**"],
  "consumers": ["api-integration"],
  "description": "optional human note"
}
```

- It lives in **`contracts.json` at the universe root**.
- It is **hand-edited and dev-owned**. RSCT can *guide* you through writing one
  (the `/rsct-setup` Q&A in a multi-repo setup with ≥2 registered apps), but it
  never invents the producer/consumer relationships — those are your domain
  knowledge — and you commit the universe yourself.
- **`surface`** is a list of **path globs in the producer repo**.

### Surface glob syntax

Surface globs support exactly three wildcards — `*`, `**`, `?` only:

| Pattern | Matches |
|---|---|
| `*` | Any run of characters **except** `/` (one path segment). |
| `**` | Any number of path segments, including `/`. |
| `?` | Exactly one character except `/`. |

**Brace alternation (`{a,b}`) and bracket classes (`[abc]`) are NOT supported** —
they are treated as *literal* text. Writing `src/{api,rpc}/**` declares a surface
that only matches a file literally named `src/{api,rpc}/...`, so it will never
gate the real `src/api/` or `src/rpc/` paths. Write them as separate surface
entries instead. Also note `dir/**` needs the trailing slash and does **not**
match a sibling file named `dir.ext`.

A contract whose `surface` is empty never gates (it is kept but flagged in the
diagnostic note as "can never gate"). A malformed entry is dropped.

## Producer vs consumer

This is the single most important fact about the contract gate, and the one
most often misunderstood:

> **The contract-surface gate protects the *producer* repo. A commit in the
> producer repo that touches a declared surface is gated. Consumer repos are
> never blocked by the surface gate.**

```
   Producer repo  (app = "api-python-client")          Consumer repo (app = "api-integration")
   ────────────────────────────────────────────        ───────────────────────────────────────
   contracts.json (in the universe) says:
     producer:  api-python-client
     surface:   openapi/*.yaml, src/api/**
     consumers: api-integration

   commit touches src/api/...   ──► GATE FIRES          commit touches anything   ──► not gated
     "this surface is consumed by api-integration;        by the surface gate
      confirm or override before committing"            (normal branch/secret rules still apply)
```

The gate fires only when **all** of these hold:

1. The app's confirmed `topology.mode` is `multi-repo` (an inferred-but-unconfirmed
   mode never gates).
2. The universe is linked and resolvable.
3. `contracts.json` exists at the universe root.

…and the commit is in the **producer** repo touching one of that producer's
surfaces.

**Producer matching is exact and case-sensitive.** A contract's `producer` must
equal your app's `name` in `.rsct.json` (`app.name`) character-for-character —
`MyApp` does not match `myapp`. If the gate isn't firing where you expect, this
mismatch is the first thing to check. `rsct_get_topology` surfaces it for you:
it **warns when a contract's `producer` matches no registered app** — or matches
only by case (a case-only typo the gate silently treats as unregistered) — and
suggests the correctly-cased name to use. So a misspelled or mis-cased producer
is caught proactively instead of silently never gating. The same check also
covers every contract **`consumer`** and this repo's own **`app.name`**, flagging
case-only drift (e.g. a folder-cased `app.name`) as a likely typo — only the
`producer` actually gates, but the warnings catch the mistakes early.

**Overriding.** When you genuinely intend a surface change, approve it with a
per-action override carrying a reason (`override_contract_surface: { reason }`).
A batch **plan-authorization token never bypasses the contract gate** — it is a
hard block on the token path, by design; you give an explicit per-action approval
with the override reason.

For the exact tool fields (the `produced[]` / `consumed[]` lists, the contract
graph payload, the override field), see
[`rsct_get_topology`](../mcp-server/README.md#rsct_get_topology).

## Multi-repo setup — step by step

1. **Create the universe** (org owner, once): in the directory where the universe
   should live, run [`/rsct-universe`](commands.md#rsct-universe). Commit
   the skeleton.
2. **In each app repo**, run [`/rsct-setup`](commands.md#rsct-setup), then
   [`/rsct-universe`](commands.md#rsct-universe) to link it to the
   universe. Confirm the topology as `multi-repo` when asked.
3. **Register the apps**: re-running `/rsct-setup` in a linked app offers
   (consent-gated) to register it into the universe's `applications/`. Review and
   commit the universe.
4. **Declare a contract**: once two or more apps are registered, `/rsct-setup`
   can guide the producer through declaring a surface (it asks producer, surface
   globs, consumers). It writes the entry into the universe's `contracts.json`;
   you review and commit the universe.
5. **See it work**: in the producer repo, stage a change touching a declared
   surface and ask Claude to commit. The gate fires, naming the affected
   consumers. Approve with an override reason when the change is intended.

If the gate doesn't behave as expected, see
[Troubleshooting](troubleshooting.md#the-contract-gate-isnt-doing-what-i-expect).
