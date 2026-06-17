# Module: payments

## Purpose

Captures payments via Stripe (cards) and Mercado Pago (Pix). Orchestrates
webhook handling and reconciliation events. Does NOT own refund policy
(business-rules BR-004) or invoicing.

## API exposed

| Method | Path | Auth required | Description |
|---|---|---|---|
| POST | /payments/checkout | yes | Initiate a payment session |
| POST | /webhooks/stripe | webhook secret | Receive Stripe events |
