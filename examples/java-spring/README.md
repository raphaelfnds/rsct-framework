# Tests — api-example

## Test framework

JUnit 5 + Testcontainers 1.19 + MockMvc + Mockito 5

## How to run

```bash
# Full suite (Docker required for Testcontainers)
./mvnw test

# Unit tests only (no Docker needed)
./mvnw test -Dgroups=unit

# Integration tests only
./mvnw test -Dgroups=integration

# Single test class
./mvnw test -Dtest=AuthControllerTest

# Coverage report (output: target/site/jacoco/index.html)
./mvnw verify
```

## Prerequisites

- Docker running (Testcontainers spins up PostgreSQL 15 automatically)
- No local DB needed for tests — Testcontainers handles everything
- `.env` not required for tests — `application-test.properties` overrides all

## Critical flows covered

| Flow | Test class | Type |
|---|---|---|
| Login with valid credentials | `AuthControllerTest` | Integration |
| Login with invalid credentials | `AuthControllerTest` | Integration |
| Access protected endpoint with valid JWT | `AuthControllerTest` | Integration |
| Access protected endpoint without JWT | `AuthControllerTest` | Integration |
| Refresh token — valid | `AuthControllerTest` | Integration |
| Refresh token — expired | `AuthControllerTest` | Integration |
| Logout revokes refresh token | `AuthControllerTest` | Integration |
| JWT token generation and validation | `JwtServiceTest` | Unit |
| Tenant resolved from subdomain | `TenantInterceptorTest` | Integration |
| Unknown subdomain returns 404 | `TenantInterceptorTest` | Integration |
| Tenant data isolation (two tenants, no cross-read) | `TenantRoutingTest` | Integration |
| Flyway migration runs on new tenant schema | `TenantServiceTest` | Integration |

## Flows not yet covered (known gaps)

| Flow | Priority | Notes |
|---|---|---|
| Concurrent requests — tenant context isolation | High | ThreadLocal leak risk under concurrency |
| Refresh token cleanup (expired tokens) | Medium | No job exists yet |
| Rate limiting on login endpoint | Low | Not implemented yet |
| Async code — tenant context propagation | Medium | Risk identified in impact/tenant.md |

## CI pipeline

Tests run on every PR via GitHub Actions (`.github/workflows/test.yml`).
Docker is available in the CI environment.
PRs cannot be merged if tests fail.
Coverage minimum: 70% (enforced by JaCoCo plugin in `pom.xml`).
