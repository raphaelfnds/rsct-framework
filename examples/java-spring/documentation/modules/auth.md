<!-- RSCT-GENERATED v=1.0.0 created=2026-04-12T10:00:00Z sha256-body=b474407b6602efb13044cc344e24531ea7a1845d2cb4365dc3f306c042e31d1a -->
# Impact: auth

See module: [modules/auth.md](../modules/auth.md).

## Typical changes

- Add new field to `LoginResponse` (e.g., user roles, permissions)
- Change JWT expiration time
- Add OAuth2 / SSO provider
- Change refresh token TTL or rolling behavior
- Add rate limiting to login endpoint
- Rotate JWT secret

## Who depends on this module

- **All protected endpoints**: depend on `JwtAuthFilter` populating SecurityContext
- **tenant module**: reads authenticated user from SecurityContext
- **user module**: `UserDetailsService` implementation is called during login
- **All frontend clients**: consume `/auth/login` and `/auth/refresh`
- **Mobile clients (third-party)**: if any, consume the same endpoints

## Risk by change type

| Change | Risk | What can break |
|---|---|---|
| Add field to `LoginResponse` | Low | No breaking change if additive |
| Remove field from `LoginResponse` | High | All clients consuming that field break |
| Change JWT signing algorithm | High | All active tokens become invalid — all users logged out |
| Rotate `JWT_SECRET` | High | All active sessions invalidated immediately |
| Change JWT expiration | Medium | User experience; longer = security risk; shorter = UX friction |
| Reorder filters in `SecurityConfig` | High | Tenant resolution, auth, and other filters may fail silently |
| Change refresh token TTL | Medium | Users affected differently depending on session age |
| Add new endpoint under `/auth/**` | Low | Verify `SecurityConfig` permits or requires auth correctly |
| Change `UserDetailsService` contract | High | Login flow and token validation break |

## Non-obvious couplings

- **tenant module depends on auth execution order**: if auth filter fails or is
  reordered, `TenantInterceptor` receives no authenticated user in SecurityContext.
  Symptoms appear in tenant module, root cause is in auth.
- **`JWT_SECRET` is a shared secret**: changing it requires coordinating a
  maintenance window. There is no graceful rotation mechanism in v1.
- **Refresh tokens accumulate**: no cleanup job exists. Table grows indefinitely
  until manually pruned. Monitor `users.refresh_tokens` row count.

## Checklist before merging any auth change

- [ ] `./mvnw test -Dtest=AuthControllerTest,AuthServiceTest,JwtServiceTest` passes
- [ ] Login → access protected endpoint → logout flow tested manually
- [ ] Token expiry edge case verified (expired access + valid refresh → refresh works)
- [ ] `SecurityConfig` permit/deny rules reviewed against all existing endpoints
- [ ] No secrets committed (`git diff --cached` inspected)
- [ ] If JWT_SECRET changed: operations team notified, maintenance window confirmed
- [ ] If LoginResponse changed: frontend and any mobile clients notified
