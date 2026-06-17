# Business rules — sample-app

## Pricing & checkout

### BR-001 — Cart total includes tax post-shipping
Tax is computed on the line subtotal plus the shipping fee. Mirrors the legacy ERP behaviour so reconciliation matches.

### BR-002 — Promo codes never stack
Only one promotional code applies per order. The system picks the highest-value code when multiple are valid; UI must surface which one was applied.

## Payments

### BR-003 — Pix payments expire after 30 minutes
Once a Pix QR is generated, the payment intent expires at 30min. After expiry the order returns to pending_payment and the customer must re-initiate.

### BR-004 — Refunds for Stripe go through original PaymentIntent
Refunds must reference the original PaymentIntent. Off-platform refunds (e.g., manual bank transfer) are logged but never trigger Stripe API calls.
