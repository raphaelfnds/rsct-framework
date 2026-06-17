# Module: orders

## Purpose

Owns the order lifecycle from creation through fulfillment. Maintains the
append-only `order_events` table per ADR-003. Does NOT own pricing (see
module: pricing) or payment capture (see module: payments).

## API exposed

| Method | Path | Auth required | Description |
|---|---|---|---|
| POST | /orders | yes | Create a new order |
| GET | /orders/{id} | yes | Read order state |

## Consumers

- AdminPortal: bulk read for support
- ReportingService: nightly export
