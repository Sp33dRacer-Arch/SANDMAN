# SANDMAN V1.3.1

## Production-hardening changes
- Atomic marketplace stock reservation during checkout.
- Checkout rollback that restores stock without clearing the customer's cart when payment initialization fails.
- Server-side session-bound JWT authorization and revocation.
- Memory-only access tokens in storefront/admin; persistent auth remains HttpOnly-cookie based.
- Strict Stripe PaymentIntent/order validation before payment finalization.
- Strict PayPal order identity, invoice, amount and currency validation.
- Marketplace payout gating until every item for the seller in that order has shipment tracking.
- Stripe Connect transfer idempotency and retry handling.
- Delayed-payout support through `MARKETPLACE_PAYOUT_DELAY_DAYS`.
- Idempotent supplier fulfillment per order/supplier.
- Failed supplier fulfillment retry endpoint.
- Central mixed-order fulfillment status recalculation.
- Unpaid order cancellation restores reserved marketplace stock.
- Safer manual mark-paid path through the same payment finalization logic.
- V1.3.1 Prisma migration for stock-release tracking, payout readiness and fulfillment uniqueness.

## Validation performed in the build workspace
- Every TypeScript source file parsed with the TypeScript compiler parser.
- Storefront JavaScript passed `node --check`.
- Admin JavaScript passed `node --check`.
- All relative TypeScript imports resolve to files.
- JSON files parsed successfully.
- Favicon SVG parsed successfully.
- Environment variable references were checked against `src/config/env.ts`.

The full dependency-backed `npm install`, Prisma client generation and live Stripe/PayPal/Syncee integration tests must still be run in the real project environment using the commands in `INSTALL-V1.3.1.txt`.
