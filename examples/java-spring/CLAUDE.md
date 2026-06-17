<!-- RSCT_VERSION: 1.0.0 -->
<!-- RSCT_APP: api-example | updated: 2026-05-15 -->

# CLAUDE.md — api-example

AI agent operational protocol for this repository.
Read this file at the start of every session.

---

<!-- RSCT-CANONICAL-SOURCE-BEGIN v=1.0.0 -->
## 0. Canonical architectural source

<!-- RSCT_UNIVERSE: acme | updated: 2026-05-15 -->

### 0. Permanent rule — universe access

Any access to acme-universe artifacts listed below requires:
1. Try local path first: `~/projects/acme-universe`
2. If not available locally: list URLs + reason and wait for explicit user OK.
3. This rule applies even in `Edit automatically` mode.

Source: `acme-universe/CLAUDE.md` §0.1

---

### 1. Operational protocol (read first in any session)

| | Path |
|---|---|
| Local | `~/projects/acme-universe/CLAUDE.md` |
| Remote | `https://github.com/acme-org/acme-universe/blob/main/CLAUDE.md` |

Key rules: explicit OK for commit/push; analyze impact before changing;
external access requires OK; no secrets in output.

---

### 2. App identity and operational state — api-example

**Production host(s):**
| Host | Role | Local | Remote |
|---|---|---|---|
| app-server-01 | Runtime canonical | `~/projects/acme-universe/hosts/app-server-01/operational-state.md` | `https://github.com/acme-org/acme-universe/blob/main/hosts/app-server-01/operational-state.md` |

Application:
- Local: `~/projects/acme-universe/applications/api-example/README.md`
- Remote: `https://github.com/acme-org/acme-universe/blob/main/applications/api-example/README.md`

---

### 3. Governance affecting this app

| Artifact | Local | Remote |
|---|---|---|
| Status matrix | `~/projects/acme-universe/docs/governance/document-control.md` | `https://github.com/acme-org/acme-universe/blob/main/docs/governance/document-control.md` |
| Subdomains | `~/projects/acme-universe/docs/governance/dns-governance-survey.md` | `https://github.com/acme-org/acme-universe/blob/main/docs/governance/dns-governance-survey.md` |
| LGPD | `~/projects/acme-universe/docs/governance/lgpd-system-matrix.md` | `https://github.com/acme-org/acme-universe/blob/main/docs/governance/lgpd-system-matrix.md` |
| Canonical sources | `~/projects/acme-universe/docs/governance/canonical-sources-map.md` | `https://github.com/acme-org/acme-universe/blob/main/docs/governance/canonical-sources-map.md` |
| Naming standards | `~/projects/acme-universe/docs/governance/naming-standards.md` | `https://github.com/acme-org/acme-universe/blob/main/docs/governance/naming-standards.md` |

---

### 4. Architectural diagrams

| Diagram | Local | Remote |
|---|---|---|
| C4 Context (ecosystem) | `~/projects/acme-universe/docs/diagrams/c4-context-ecosystem.drawio` | `https://github.com/acme-org/acme-universe/blob/main/docs/diagrams/c4-context-ecosystem.drawio` |
| C4 Containers (api-example) | `~/projects/acme-universe/docs/diagrams/c4-containers-api-example.drawio` | `https://github.com/acme-org/acme-universe/blob/main/docs/diagrams/c4-containers-api-example.drawio` |
| Deployment macro | `~/projects/acme-universe/docs/diagrams/deployment-macro.drawio` | `https://github.com/acme-org/acme-universe/blob/main/docs/diagrams/deployment-macro.drawio` |
| DFD macro | `~/projects/acme-universe/docs/diagrams/dfd-macro.drawio` | `https://github.com/acme-org/acme-universe/blob/main/docs/diagrams/dfd-macro.drawio` |
| Security map ISO/LGPD | `~/projects/acme-universe/docs/diagrams/security-map-iso-lgpd.drawio` | `https://github.com/acme-org/acme-universe/blob/main/docs/diagrams/security-map-iso-lgpd.drawio` |

---

### When to consult each category

- **Cat. 1**: always, at the start of any session (local first).
- **Cat. 2**: before changing runtime config, infra, deploy, .env, DB, allowlist.
- **Cat. 3**: before changing domains, personal data, retention, LGPD, naming.
- **Cat. 4**: before proposing relevant architectural change.
<!-- RSCT-CANONICAL-SOURCE-END -->

---

<!-- RSCT-§A-BEGIN v=1.0.0 source=inserted -->
## §A — Bug mode (sequential tutor)

When the task is bug diagnosis (reported suspicion, unexpected behavior,
unhandled exception, regression), act as a sequential tutor, not as
autonomous executor:

1. Confirm the suspicion with the user before starting — formulate a clear
   hypothesis in 1-2 sentences.
2. Suggest one inspection step at a time (log reading, SELECT query, curl,
   status check, code reading). Wait for the result.
3. Analyze the return and propose the next step, until identifying root cause
   confirmed by evidence (not by inference).
4. Only after root cause is confirmed, exit bug mode and return to §B
   (plan with 2 options) to propose the fix.

Controlled exception for block inspection: up to 5 read-only commands may be
proposed together when all are independent and the block has one explicit goal.
Mutations are never grouped — always one at a time, with OK per action.

Summary:
- §B does not apply during bug inspection.
- §C remains fully in force in bug mode.
<!-- RSCT-§A-END -->

---

<!-- RSCT-§B-BEGIN v=1.0.0 source=inserted -->
## §B — Mandatory plan before editing code

NEVER edit code without first presenting the user a plan containing:

1. At least 2 execution options with evaluated impacts for each. **One option
   must be explicitly marked Recommended** with a 1-2 sentence reason. The
   developer may override; the recommendation must always be visible.
2. Reuse analysis: existing functions, classes, services, components or
   algorithms in the project that fully or partially cover the need.
3. Explicit no-reuse option when a reuse alternative exists.
4. Merging possibility: user can choose, request refinement, or mix options.
5. **Mandatory read of `documentation/decisions.md` before formulating options:**
   - **Firm premises (#N)** are non-negotiable — discard any option that
     violates one, or escalate the conflict to the user explicitly.
   - **Existing ADRs (ADR-NNN)** — alternatives already discarded must not
     be re-proposed without citing the ADR and giving a reason for re-opening.
   - **Out of scope** section flags areas where proposals must be questioned.
6. **Plan tracking files (after dev approval):**
   - Create `plan_<slug>.md` and `progress_<slug>.md` at project root from
     `doc-templates/plan_slug.md.template` and `progress_slug.md.template`.
   - Slug = derived from current branch name (`feat/foo-bar` → `foo-bar`).
   - Gitignored by default; tell dev to use `git add --force` to track on
     this feature branch. **NEVER on main/test branches.**
   - Update `progress_<slug>.md` after every meaningful step.
   - **Proactive session resume:** watch 3 signals — (1) platform auto-compact
     reminders; (2) operation count heuristic (4+ commits / 6+ edits /
     30+ messages / multi-agent); (3) plan milestone (section done, commit,
     blocker). On any signal: update progress, refresh "Session resume" block,
     and PROACTIVELY ask dev: continue here / generate resume + new session /
     show resume. Do NOT wait for dev to bring it up.

The plan must be approved before any edit in executable behavior files
(.java, .properties, .yml, pom.xml, etc.).

Even when the user explicitly requests reuse, the concrete application of
reuse must be presented and approved before editing.

**Integrated checks in every plan:**

Reversibility check (§F): for any flow that changes persistent state,
the plan must include: "Is a reverse operation needed? Who has permission
to execute it?"

Testing check (§G): the plan must include: "Do you want automated tests
in this plan?"

Exceptions to §B:
- Trivial isolated edits in documentation (*.md) or typo fixes.
- Active debug session (§A): inspection commands only; mutations still
  require plan + OK.
- When in doubt, always require a plan.

### §A — Bug mode (2.1)
See §A above.
<!-- RSCT-§B-END -->

---

<!-- RSCT-§C-BEGIN v=1.0.0 source=inserted -->
## §C — Explicit authorization — does not reuse

Prohibited without explicit user authorization in this session:

- Create commit
- Push to any branch
- Perform branch merge
- Execute deploy or release
- Execute migration in real environment
- Apply changes to auth, tenant context, persistence core or public contracts

**Authorization does not reuse.** Each occurrence requires an updated OK.
"Already authorized" does not apply to the next action.

**Universal override path:** the dev can bypass ANY framework rule (§A–§H)
with an explicit, single-action OK. Examples: "commit direto na main", "skip
plan and apply directly". Before acting: restate override in 1 line, wait
for OK, apply once. Next similar action requires fresh OK. Framework guides;
dev decides.
<!-- RSCT-§C-END -->

---

<!-- RSCT-§D-BEGIN v=1.0.0 source=inserted -->
## §D — Protected branches

Treat `main` and `test` as protected branches.
Without explicit reconfirmed authorization:

- Prohibited: commit, push, merge, rebase, reset, force push, checkout for edit.
- Allowed without OK: reading (git log, git diff, git show).
- For mutating work: create derived branch (feat/, fix/, chore/, docs/) + PR.

**Active branch verification at task boundaries:**

At the start of every task and after any pause, run
`git rev-parse --abbrev-ref HEAD`. If current branch differs from the
branch where the prior plan was approved (see `plan_<slug>.md`), explicitly
ask the developer which branch to continue in. If on `main`/`test`/`dev`,
strongly recommend creating a derived branch before any mutation.
<!-- RSCT-§D-END -->

---

<!-- RSCT-§E-BEGIN v=1.0.0 source=inserted -->
## §E — Secrets and sensitive info

Before any commit, push or external output, verify absence of:

**Project-specific variables** (from .env.example):
- `DB_PASSWORD`, `DB_URL`, `DB_USERNAME`
- `JWT_SECRET`, `JWT_EXPIRATION`
- `MAIL_PASSWORD`, `MAIL_USERNAME`
- `API_KEY_EXTERNAL_SERVICE`

**General categories:**
- Any token, certificate, hash, decodable JWT or secret-looking string
- Absolute paths with OS username (C:\Users\<name>\..., /home/<name>/...)
- Internal hostnames, IPs, WSL paths
- Real personal data: CPF, email, phone, client name, card data
- Content copied from logs or other system terminals

The .env must be in .gitignore.
The .env.example must have only empty keys or generic placeholders.

How to apply: run `git diff --cached`, inspect visually, grep for known
patterns. In any doubt — stop and ask the user.
<!-- RSCT-§E-END -->

---

<!-- RSCT-§F-BEGIN v=1.0.0 source=inserted -->
## §F — State reversibility and permissions (IDA/VOLTA)

This rule is a reminder integrated into §B (planning), not a blocker.

**When it applies:** any operation that changes persistent state: create,
save, group, approve, publish, activate, link, generate.

**Two mandatory questions in every plan:**

1. **Permissions**: will the user have permission to execute this operation?
   Check existing RBAC/roles in the codebase. If not found: ask developer.
   Same question applies to the reverse operation.

2. **Reversibility**: is a reverse operation needed?
   Define what "reverse" means in this domain.
   Example: "cancel order" must restore inventory, not just delete the record.

If developer accepts implementing the reverse flow: follow §B + §C.
If not: proceed normally.
<!-- RSCT-§F-END -->

---

<!-- RSCT-§G-BEGIN v=1.0.0 source=inserted -->
## §G — Testing — integrated into planning

Detected framework: **JUnit 5 + Testcontainers + MockMvc**

After every new implementation, improvement or bug fix:
1. Identify existing tests that cover the changed code.
2. Check if they need to be adjusted (§B — plan + reuse).
3. Propose new tests for new functionality following existing patterns.
4. Tests follow: §B (plan), §C (OK for commit/push), §D (branches).
5. Before closing: confirm suite passes locally or ask dev to confirm manual testing.

**QA Planner Mode** (on demand, designs the suite):
- Map critical flows and propose minimum viable coverage.
- Prioritize integration tests with Testcontainers + real PostgreSQL.
- Do not invent test data with real personal information (§E).
- Follow §B for each proposed test group.

**QA Tester Execution Mode** (activated when running tests, not designing):
- Requirements analysis from decisions.md + plan_<slug>.md before testing.
- Manual testing including edge cases + error cases.
- Bug report on failure: numbered reproduction steps, expected vs actual,
  severity, suspected cause — logged in progress_<slug>.md Discoveries.
- Activate §A (bug mode) for investigation if dev approves.
- Note test automation gaps; propose new test via §B.
- Does NOT auto-fix bugs — documents and escalates.
<!-- RSCT-§G-END -->

---

<!-- RSCT-§H-BEGIN v=1.0.0 source=inserted -->
## §H — ADR auto-learning

During any session, when a decision meets ANY criterion below, ask the
developer if they want to record it in `documentation/decisions.md`:

- Decision with no defined expiration (permanent or indefinite)
- Technology, library, pattern or architectural choice
- Firm business or technical constraint
- Explicit choice not to implement something
- Result of a debate where an alternative was discarded

Format: firm premises (#N) or durable ADRs (ADR-NNN, append-only).
Never rewrite an existing ADR. Propose once per decision per session.
<!-- RSCT-§H-END -->
