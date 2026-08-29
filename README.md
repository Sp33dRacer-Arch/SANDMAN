# SANDMAN V1.4.2

SANDMAN is a custom automotive-parts ecommerce + marketplace backend and storefront.

V1.4.2 keeps the V1.4.1 payment, refund, payout, session and marketplace hardening and fixes the three final issues found in the second audit: accepted-offer quantity enforcement, mixed-order refund/fulfillment status accounting, and atomic dropship supplier inventory reservations.

## Important

Do **not** deploy V1.4.2 over the live store before the dependency-backed checks pass on your PC. This package has passed the static audit included with it, but this workspace cannot download npm dependencies or run a real Prisma/TypeScript build against your PostgreSQL database.

## Local verification

1. Extract V1.4.2 into a separate folder.
2. Copy your own `.env` values into it. Never commit `.env`.
3. Run `npm install`.
4. Run `./VERIFY-V1.4.2.ps1` in PowerShell, or run `npm run verify`.
5. Test `npm run prisma:deploy` against a staging/test PostgreSQL database first.
6. Test Stripe/PayPal in sandbox mode before production.

`npm install` will create `package-lock.json`. Keep and commit it after the full verification passes.

## V1.4.2 fixes

- Accepted offers are quantity-1 only at add-to-cart, cart update **and checkout**, so a negotiated unit price cannot be multiplied across extra units.
- Mixed orders now count only shipped fulfillments belonging to suppliers that still have a non-refunded line in the order.
- Dropship inventory now has reported stock, reserved stock and buyer-facing available stock.
- Checkout atomically reserves supplier inventory to prevent two buyers claiming the last known unit.
- Failed, cancelled and expired checkouts restore supplier reservations.
- Supplier feed updates preserve live reservations instead of overwriting them.
- Releasing a reservation recalculates availability from the latest supplier stock, so a supplier feed change cannot accidentally recreate sold-out stock.
- Supplier reservations are committed after the supplier order exists, with an idempotent repair path for crash windows.
- Fully refunded dropship lines release an uncommitted supplier hold.
- Product/search/recommendation availability uses `availableStock`, not the raw supplier snapshot.

## Railway commands

Build: `npm run prisma:generate && npm run build`

Pre-deploy: `npm run prisma:deploy`

Start: `node dist/src/server.js`

Health check: `/api/health`

Recommended values:

- `MARKETPLACE_PAYOUT_DELAY_DAYS=7`
- `CHECKOUT_RESERVATION_MINUTES=30`
- `BANK_TRANSFER_RESERVATION_HOURS=48`
- `AUTO_PRICE_SUPPLIER_FEEDS=false` until pricing rules are tested
- Change `DEFAULT_SUPPLIER=mock` before real supplier orders

## External services still required

- Stripe + Stripe Connect for marketplace checkout and seller payouts.
- PayPal credentials if PayPal checkout is enabled.
- A real supplier integration/feed for live stock and fulfillment.
- An email provider for real outbound email.
- Persistent object storage for seller/review images.

## Production safety

Never put payment keys, JWT secrets, supplier secrets or database credentials in source control. Do not run the demo seed in production unless you intentionally set `ALLOW_DEMO_SEED=true`.
