# Architectural decisions — sample-app

## Firm premises (non-negotiable)

### #1 — Append-only finance events
Financial events are immutable once committed. Corrections via compensating events.

### #2 — LGPD compliance baseline
PII never logged in plaintext; access auditable.

### #3 — Synchronous webhook acks
External webhooks must ack within 5s or be retried via outbox.
**Tags**: webhooks, reliability

---

## Durable architectural decisions (ADRs)

### ADR-001 — PostgreSQL as primary store (2026-01-15, ref: PR #12)
**Context**: needed transactional storage.
**Decision**: PostgreSQL 16 on RDS.
**Consequences**: regional replication adds cost; ORM = JPA/Hibernate.

### ADR-002 — Stripe for payment capture (2026-02-20, ref: PR #45)
**Context**: needed PCI-compliant payment.
**Decision**: Stripe Checkout for cards; Pix via Mercado Pago.
**Consequences**: webhook reliability is a hard dependency.

### ADR-003 — Event sourcing for orders (2026-03-10, ref: PR #88)
**Context**: audit trail requirement from finance.
**Decision**: order_events table, append-only, materialized cart view.
**Consequences**: more code, but enables time-travel debugging.

### ADR-004 — Redis as session store (2026-04-02, ref: PR #102)
**Status**: superseded
**Tags**: cache, sessions
**Context**: needed fast session lookup.
**Decision**: Redis 7 single-node; superseded by ADR-007 (cluster).
**Consequences**: replaced after scaling concerns surfaced.

### ADR-007 — Redis cluster for session store (2026-05-18, ref: PR #154)
**Status**: active
**Tags**: cache, sessions, scaling
**Context**: ADR-004 single-node hit memory ceiling at 80 concurrent sessions per pod; failover required full app restart.
**Decision**: 3-node Redis cluster with managed failover; supersedes ADR-004.
**Consequences**: operational complexity higher, but horizontal scaling unblocks the multi-tenant rollout.

---

## Out of scope

- Multi-currency at launch.
