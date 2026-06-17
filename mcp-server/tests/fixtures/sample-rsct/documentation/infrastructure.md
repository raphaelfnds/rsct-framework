# Infrastructure inventory — sample-app

## Inventory

### INFRA-001 — Primary database
- **Type:** database
- **Provider + region:** AWS RDS PostgreSQL, us-east-1
- **Version / SKU:** PostgreSQL 16.2, db.m5.large
- **Used by:** all backend services (orders, payments, customers)
- **Operational facts designers need:**
  - max_connections: 200; reserve 20 for ops
  - Backup window 03:00-04:00 UTC; PITR 7 days
- **HA / failover:** Multi-AZ enabled; auto failover ~60-90s
- **Connection point (sanitized):** `<env>-db.<region>.rds.amazonaws.com:5432`
- **Owner (internal):** alice
- **Captured:** 2025-10-15 by alice

### INFRA-002 — Session cache
- **Type:** cache
- **Provider + region:** AWS ElastiCache Redis, us-east-1
- **Version / SKU:** Redis 7.2 cluster mode
- **Used by:** AuthService, RateLimiter
- **HA / failover:** Multi-AZ enabled
- **Connection point (sanitized):** `<env>-redis.<region>.cache.amazonaws.com:6379`
- **Captured:** 2025-10-15 by alice
