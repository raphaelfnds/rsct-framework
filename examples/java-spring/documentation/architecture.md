<!-- RSCT-GENERATED v=1.0.0 created=2026-04-12T10:00:00Z sha256-body=96dc1b55e32cc7723ebddc1b47c70265986d1c68e5fc25377c5b80108b95dc47 -->
# Architecture — api-example

## Stack

| Layer | Technology | Version |
|---|---|---|
| Language | Java | 21 (LTS) |
| Framework | Spring Boot | 3.2 |
| Build | Maven | 3.9 |
| Database | PostgreSQL | 15 |
| Data access | Spring Data JPA + EntityManager | — |
| Migrations | Flyway | 10 |
| Auth | Spring Security + JWT | — |
| Tests | JUnit 5 + Testcontainers + MockMvc | — |
| Docs | Swagger / OpenAPI 3 | springdoc 2.x |

## Entrypoints

| File | Purpose |
|---|---|
| `src/main/java/com/acme/api/ApiExampleApplication.java` | Main class — Spring Boot bootstrap |
| `src/main/resources/application.properties` | Base configuration |
| `src/main/resources/application-dev.properties` | Dev overrides |
| `src/main/resources/application-prod.properties` | Prod overrides |

## Runtime flow

```
Client request
  → Nginx (reverse proxy, SSL termination)
  → Spring Boot embedded Tomcat (port 8080)
  → Spring Security filter chain (JWT validation)
  → Controller layer (@RestController)
  → Service layer (@Service)
  → Repository layer (JPA / EntityManager)
  → PostgreSQL
```

## Multi-tenancy

Tenant is identified by subdomain at request time (e.g., `client1.api-example.com`).
Each tenant has an isolated database schema. Schema resolution happens in
`TenantContext` (ThreadLocal) populated by `TenantInterceptor` before the
controller is reached.

Schemas per tenant: `conect`, `orders`, `users`
Shared schema: `public` (system configuration, tenant registry)

## Persistence

- **Spring Data JPA**: standard CRUD repositories
- **EntityManager**: complex queries and bulk operations
- **JdbcTemplate**: reporting queries and raw SQL where performance is critical
- **Flyway**: migrations centralized in `src/main/resources/db/migration/`
  - Tenant migrations: `db/migration/tenants/`
  - History tracked in `migration` schema

## Build and environments

| Environment | How to activate | Key differences |
|---|---|---|
| dev | default profile | H2 NOT used — Testcontainers for tests; real local DB for dev |
| test | `SPRING_PROFILES_ACTIVE=test` | Testcontainers spins up real PostgreSQL |
| prod | `SPRING_PROFILES_ACTIVE=prod` | Stricter logging; no Swagger UI |

## Environment variables

| Variable | Description | Required |
|---|---|---|
| `DB_URL` | JDBC URL — e.g., `jdbc:postgresql://localhost:5432/apiexample` | Yes |
| `DB_USERNAME` | Database username | Yes |
| `DB_PASSWORD` | Database password | Yes |
| `JWT_SECRET` | HS256 signing secret (min 32 chars) | Yes |
| `JWT_EXPIRATION` | Token expiry in ms — e.g., `86400000` | Yes |
| `MAIL_HOST` | SMTP host | No (features degrade) |
| `MAIL_PORT` | SMTP port | No |
| `MAIL_USERNAME` | SMTP user | No |
| `MAIL_PASSWORD` | SMTP password | No |
| `API_KEY_EXTERNAL_SERVICE` | Third-party integration key | No |

## Source code directories

| Path | Responsibility |
|---|---|
| `src/main/java/com/acme/api/auth/` | JWT generation, validation, Spring Security config |
| `src/main/java/com/acme/api/tenant/` | Multi-tenant context, schema routing, interceptor |
| `src/main/java/com/acme/api/user/` | User domain: entity, repository, service, controller |
| `src/main/java/com/acme/api/order/` | Order domain |
| `src/main/java/com/acme/api/common/` | Shared utilities, exception handlers, DTOs base |
| `src/main/resources/db/migration/` | Flyway migrations (versioned SQL files) |
| `src/test/java/com/acme/api/` | Test suite — mirrors main package structure |
