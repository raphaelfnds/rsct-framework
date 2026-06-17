# Anti-decisions — sample-app

## Vendor experiments that were rolled back

### AD-001 — DynamoDB for orders (2025-09, rolled back 2025-11)
Tried DynamoDB to escape JPA boilerplate. Cost of strong-consistency reads and lack of joins forced rollback to Postgres. Do not revisit without a different read pattern.

### AD-002 — Service-mesh for inter-service auth (2025-12, rolled back 2026-02)
Istio sidecar added 80ms p95 latency to internal calls. JWT bearer between services was already sufficient. Mesh adoption blocked unless we have ≥5 services and zero-trust mandate.
