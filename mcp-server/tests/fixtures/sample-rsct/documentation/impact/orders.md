# Impact: orders

See module: [modules/orders.md](../modules/orders.md).

## Typical changes

- New event type appended to order_events
- New API endpoint exposing existing events

## Non-obvious couplings

- **Reporting nightly job**: queries `order_events` directly; adding a new
  event type without updating the reporting schema causes silent drops.
- **AdminPortal pagination**: uses `(created_at, id)` cursor — never
  rewrite the index on `order_events` without coordinating.

## Checklist before merging any orders change

- [ ] OrderEventServiceIntegrationTest passes
- [ ] Manual smoke: create order via POST /orders then read state
- [ ] If event schema changed: ReportingService schema confirmed
