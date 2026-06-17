<!-- RSCT-GENERATED v=1.0.0 created=2026-04-12T10:00:00Z sha256-body=1a19b0cda44f24e9170676dc188c60579d75fdd9cc24f74a730f8b1fd89f5c16 -->
# Module: auth

## Purpose

Handles all authentication and authorization concerns:
JWT token generation and validation, Spring Security filter chain configuration,
login and logout endpoints, refresh token lifecycle.

## Files involved

```
src/main/java/com/acme/api/auth/
├── AuthController.java          ← REST endpoints: /auth/login, /auth/refresh, /auth/logout
├── AuthService.java             ← login logic, token generation, refresh token management
├── JwtService.java              ← JWT sign, parse, validate (HS256)
├── JwtAuthFilter.java           ← OncePerRequestFilter — validates token on every request
├── SecurityConfig.java          ← Spring Security bean configuration
├── RefreshToken.java            ← Entity: refresh_tokens table
├── RefreshTokenRepository.java  ← JPA repository for refresh tokens
└── dto/
    ├── LoginRequest.java
    ├── LoginResponse.java
    └── RefreshRequest.java
```

## API exposed

| Method | Path | Auth required | Description |
|---|---|---|---|
| POST | `/auth/login` | No | Authenticate with email + password; returns access + refresh tokens |
| POST | `/auth/refresh` | No (refresh token in body) | Returns new access token |
| POST | `/auth/logout` | Yes (access token) | Revokes refresh token server-side |

## Main flows

**Login flow:**
1. `AuthController.login()` receives `LoginRequest`
2. `AuthService.authenticate()` validates credentials via `UserDetailsService`
3. `JwtService.generateToken()` creates 24h access token
4. `AuthService.createRefreshToken()` persists 30d refresh token in DB
5. Returns `LoginResponse` with both tokens

**Token validation flow (every request):**
1. `JwtAuthFilter` extracts Bearer token from `Authorization` header
2. `JwtService.validateToken()` verifies signature and expiry
3. If valid: sets `SecurityContextHolder` with user details + tenant context
4. If invalid/missing: chain continues without authentication (401 on protected routes)

**Refresh flow:**
1. Client sends expired access token + valid refresh token
2. `AuthService.refreshAccessToken()` validates refresh token exists and is not expired
3. Generates new access token; refresh token TTL is NOT extended (rolling not implemented)

## Consumers

- All protected endpoints depend on `JwtAuthFilter` populating `SecurityContextHolder`
- `TenantInterceptor` (tenant module) reads user from SecurityContext to resolve tenant

## Points of attention

- **Refresh token revocation**: `POST /auth/logout` MUST be called to revoke server-side.
  Client-side token discard alone does not invalidate the refresh token.
- **Tenant resolution dependency**: auth must complete before tenant resolution.
  Filter order in `SecurityConfig` is load-bearing — do not reorder filters.
- **Token secret rotation**: changing `JWT_SECRET` invalidates all active sessions.
  Coordinate with operations before rotating in production.
- **Refresh token cleanup**: expired tokens are not automatically deleted.
  A scheduled cleanup job is tracked as a future task (see decisions.md out of scope).
