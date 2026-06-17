<!-- RSCT-GENERATED v=1.0.0 created=2026-04-12T10:00:00Z sha256-body=3ec9a19bf93438c5bc64d48652707b1d9d6259e9eb71713c8f969b73bdaed8c3 -->
# Architectural decisions — api-example

## Firm premises (non-negotiable)

### #1 — No H2 in-memory database for tests
All tests run against real PostgreSQL via Testcontainers.
Reason: H2 has subtle SQL dialect differences that mask production bugs,
especially in Flyway migrations and native queries.

### #2 — Flyway migrations are the only way to change schema
No schema changes via Hibernate `ddl-auto`. All DDL goes through versioned
migration files in `db/migration/`. This ensures reproducibility and auditability
across all environments.

### #3 — Tenant context is always resolved from subdomain, never from request body
The tenant identifier must come from the HTTP request subdomain, intercepted
before controllers are reached. Accepting tenant ID in request body or headers
from the client is prohibited — it is a security boundary.

### #4 — DTOs are mandatory on all public API boundaries
Entities are never serialized directly to HTTP responses. Every controller
returns a DTO. Reason: prevents accidental field exposure and decouples
persistence model from API contract.

---

## Durable architectural decisions (ADRs)

### ADR-001 — Use Testcontainers instead of H2 for integration tests (2025-08-10, ref: PR #12)
**Context**: The team was using H2 for integration tests. Several bugs in
native PostgreSQL queries and Flyway migrations were only caught in production.
**Alternatives considered**: H2 with PostgreSQL compatibility mode; mock
repositories; dedicated test database.
**Decision**: Testcontainers with real PostgreSQL 15 image for all integration
tests. Unit tests use mocks (Mockito) for service layer only.
**Consequences**: Test startup is slower (~8s for container spin-up). CI must
have Docker available. Developer machines need Docker running for tests.

### ADR-002 — EntityManager for complex queries, Spring Data JPA for standard CRUD (2025-09-02, ref: PR #31)
**Context**: Some queries required joins across multiple tenant schemas and
dynamic filtering that JPQL and Spring Data derived methods handled poorly.
**Alternatives considered**: QueryDSL; jOOQ; raw JdbcTemplate for everything.
**Decision**: Spring Data JPA repositories for standard CRUD operations.
EntityManager with native SQL for complex queries. JdbcTemplate reserved for
reporting and bulk read operations where result mapping overhead matters.
**Consequences**: Three data access patterns coexist. New developers must read
this ADR before writing queries. The pattern to use must be explicit in code
comments when not obvious.

### ADR-003 — JWT stateless authentication, no server-side session (2025-09-15, ref: PR #38)
**Context**: Initial prototype used Spring Session with Redis. Added
infrastructure complexity without benefit at current scale.
**Alternatives considered**: Spring Session + Redis; opaque tokens with
database lookup; OAuth2 with external provider.
**Decision**: Stateless JWT (HS256). Tokens expire in 24h. No refresh token
in v1 (added in ADR-005). Logout implemented client-side (token discard).
**Consequences**: Token revocation not possible before expiry in v1. Acceptable
for current use case. If revocation becomes a requirement, see ADR-005.

### ADR-004 — Subdomain-based multi-tenancy, schema-per-tenant isolation (2025-10-01, ref: PR #45)
**Context**: Product requires strict data isolation between clients. Row-level
security was evaluated but added complexity to all queries.
**Alternatives considered**: Row-level security (RLS) with shared tables;
separate databases per tenant; schema-per-tenant.
**Decision**: Schema-per-tenant in the same PostgreSQL instance. Tenant
resolved from subdomain via `TenantInterceptor`. Schema switching via
`AbstractRoutingDataSource`.
**Consequences**: Maximum ~100 tenants on current infra before connection pool
pressure. Migration strategy needed for tenant onboarding (see setupdeveloper.md).
Cross-tenant queries are prohibited by design.

### ADR-005 — Refresh token added with database persistence (2026-01-20, ref: PR #89)
**Context**: Users complained about being logged out every 24h. Long-lived
access tokens were rejected (security risk).
**Alternatives considered**: Extend access token TTL to 7d; refresh token
in-memory (Redis); refresh token in database.
**Decision**: Refresh token stored in `users.refresh_tokens` table with 30d
TTL. Access token remains 24h. Refresh endpoint: `POST /auth/refresh`.
Revocation now possible by deleting refresh token record.
**Consequences**: `POST /auth/logout` must now call the API to revoke the
refresh token server-side, not just discard client-side. Frontend must be
updated (coordinated with app-example team).

---

## Out of scope

- OAuth2 / SSO with external providers (Google, Microsoft) — not planned for v1
- Real-time features (WebSocket, SSE) — evaluate in v2
- Multi-region deployment — single-region for now
- Mobile app — API only, mobile clients are third-party consumers
- Background job scheduling — use external cron triggering HTTP endpoints

---

## How to contribute new decisions

- Firm premise: append to "#N" section, sequential numbering
- ADR: append to end of "ADRs" section, ADR-NNN sequential numbering
- Chronological history lives in `git log` — this doc is current state only
- Never rewrite an existing ADR — record revision as a new ADR
