# SANDMAN — Engine Parts Dropshipping Backend

A production-minded REST API starter for a vehicle-specific engine-parts dropshipping store.

## What is already built

- Customer registration/login with JWT authentication
- PostgreSQL database with Prisma ORM
- Vehicle hierarchy: make → model → engine/vehicle variant
- Engine-code and year-based vehicle search
- Saved customer Garage with primary vehicle
- Product catalogue, categories, pricing, images and part numbers
- Vehicle-to-product fitment matrix
- Compatibility checks before products enter the cart
- Supplier catalogue links with supplier cost, shipping cost and stock
- Automatic supplier routing by priority, availability and cost
- Cart and checkout totals
- Stripe PaymentIntent checkout
- Stripe webhook payment confirmation
- Automatic order submission after successful payment
- Multi-supplier order splitting
- CJ supplier adapter boundary + safe mock supplier
- Fulfillment/tracking records
- Admin dashboard, products, fitments, suppliers and manual payment testing
- Webhook idempotency table
- Security headers, CORS, rate limiting, validation and centralized errors
- Seed data for BMW B58, Toyota Supra B58 and VW EA888 examples

## Important before selling real car parts

The seed catalogue is DEMO DATA. Engine parts have safety, warranty and fitment consequences. Verify supplier identity, manufacturer part numbers, specifications, vehicle compatibility, warranty terms and return rules before listing any real product. Do not rely on a generated fitment claim for a customer vehicle.

## 1. Requirements

- Node.js 20+
- Docker Desktop (easiest PostgreSQL setup) OR an existing PostgreSQL database
- VS Code

## 2. Open the project

```bash
cd SANDMAN-backend
npm install
```

Copy environment settings:

Windows PowerShell:
```powershell
Copy-Item .env.example .env
```

macOS/Linux:
```bash
cp .env.example .env
```

Change `JWT_SECRET` in `.env` to a long random value.

## 3. Start PostgreSQL

```bash
docker compose up -d
```

## 4. Create the database tables

```bash
npx prisma generate
npx prisma migrate dev --name init
npm run db:seed
```

## 5. Start SANDMAN

```bash
npm run dev
```

API: `http://localhost:4000`
Health check: `GET http://localhost:4000/api/health`

## Seed admin account

For LOCAL DEVELOPMENT ONLY:

- Email: `admin@sandman.local`
- Password: `SandmanAdmin123!`

Change/delete this account before production deployment.

## Core storefront flow

1. `GET /api/vehicles/makes`
2. `GET /api/vehicles/models?makeId=...`
3. `GET /api/vehicles/variants?modelId=...&year=2020`
4. `GET /api/products?vehicleVariantId=...`
5. User registers/logs in
6. `POST /api/garage`
7. `POST /api/cart/items` with `productId`, `quantity`, `vehicleVariantId`
8. `POST /api/orders/quote`
9. `POST /api/orders/checkout`
10. Frontend confirms Stripe payment using the returned `clientSecret`
11. Stripe calls `/api/webhooks/stripe`
12. SANDMAN marks the order paid and submits supplier orders automatically
13. Staff can refresh supplier tracking from the supplier fulfillment endpoint

## Example requests

### Register

```http
POST /api/auth/register
Content-Type: application/json

{
  "email": "customer@example.com",
  "password": "StrongPassword123!",
  "firstName": "Alex"
}
```

Use the returned JWT:

```http
Authorization: Bearer YOUR_TOKEN
```

### Add a part to cart

```http
POST /api/cart/items
Authorization: Bearer YOUR_TOKEN
Content-Type: application/json

{
  "productId": "PRODUCT_ID",
  "quantity": 1,
  "vehicleVariantId": "VEHICLE_VARIANT_ID"
}
```

### Checkout

```http
POST /api/orders/checkout
Authorization: Bearer YOUR_TOKEN
Content-Type: application/json

{
  "shippingAddress": {
    "firstName": "Alex",
    "lastName": "Smith",
    "line1": "123 Main Street",
    "city": "Miami",
    "state": "FL",
    "postalCode": "33101",
    "country": "US",
    "phone": "+1 555 555 5555"
  }
}
```

## Supplier strategy

Every SANDMAN product is your storefront product. It may have one or more `SupplierProduct` records. During checkout SANDMAN chooses an eligible supplier and snapshots that choice onto the order item. This lets you change suppliers later without changing product URLs or old orders.

To add another supplier, implement `SupplierAdapter` in `src/services`, register it in `supplier-registry.ts`, and create a `Supplier` record.

## CJ Dropshipping

A CJ adapter scaffold is included. CJ-specific requests live only in `src/services/cj-supplier.adapter.ts`. Before enabling it, verify the current endpoint names, authentication method, address requirements and product variant IDs against your own CJ developer account. Supplier APIs change and account permissions can differ.

## Stripe

Add to `.env`:

```env
STRIPE_SECRET_KEY=sk_...
STRIPE_WEBHOOK_SECRET=whsec_...
```

During local Stripe testing, forward events to:

```text
http://localhost:4000/api/webhooks/stripe
```

Without Stripe credentials, checkout still creates a `PENDING_PAYMENT` order so you can test the rest of the backend. An admin can use the mark-paid route with the mock supplier.

## Recommended next modules

- Real VIN decoding provider
- ACES/PIES or TecDoc-style fitment ingestion
- Supplier stock/price scheduled syncing
- Shipping-rate provider integration
- Sales tax engine
- Refund/return/RMA workflow
- Coupons and promotions
- Product reviews
- Email/SMS transactional notifications
- Background job queue (BullMQ/Redis) for supplier submission and tracking
- Object storage for product media
- Observability and audit logs

## Production notes

Do not deploy the seed password, placeholder product images, default tax rate, mock supplier, or unverified CJ field mapping to a live store. Put secrets in your hosting provider's secret manager, use HTTPS, configure production CORS, back up PostgreSQL, and add automated tests around checkout and supplier fulfillment before accepting real money.

## SANDMAN Admin V1.1

This project now includes a built-in admin console served by the same Express application.

Start the backend normally:

```bash
npm run dev
```

Then open:

```text
http://localhost:4000/admin
```

Development login from the seed data:

```text
admin@sandman.local
SandmanAdmin123!
```

Admin V1.1 includes the command-center dashboard, product catalogue management, pricing and margin visibility, product-to-vehicle fitment management, make/model/engine variant management, order and payment operations, supplier catalogue links, inventory visibility, fulfillment tracking, customer overview, and local system status.

No new Prisma migration is required for Admin V1.1 because it uses the existing schema. Change the seeded password and all development secrets before production deployment.

## V1.2 — Marketplace Storefront

SANDMAN now serves a customer-facing marketplace at `http://localhost:4000/`.

### Marketplace model

- `DROPSHIP` products are stocked by connected suppliers and follow supplier fulfillment.
- `MARKETPLACE` products are listed by authenticated SANDMAN users and can carry condition, seller stock, location and seller shipping.
- Vehicle selection is no longer required by the storefront. Fitment records remain available as product metadata.

### Routes

- Storefront: `/`
- Admin: `/admin`
- API information: `/api`
- Marketplace seller API: `/api/marketplace`
- Product catalog: `/api/products`

### Upgrading an existing v1.1 install

Apply the `20260828120500_marketplace_storefront` migration, regenerate Prisma Client, rerun the seed, then restart the server.

---

# SANDMAN V1.3.1 — Payments, Payouts, Syncee & Production Hardening

V1.3 adds production-oriented commerce features on top of the V1.2 marketplace.

## New in V1.3

- **Persistent login sessions**: short-lived JWT access tokens can be refreshed from a secure HttpOnly cookie for up to `SESSION_DAYS` (default 90 days). Browser restarts no longer force a fresh login while the persistent session is valid.
- **Change password in the website**: Admin Settings and customer Account pages can change passwords. Other persistent sessions are revoked after a password change.
- **Stripe Payment Element**: uses automatic payment methods so Stripe can show eligible cards, wallets, bank methods, BNPL and local payment methods based on merchant/customer/currency eligibility.
- **PayPal checkout**: optional PayPal Orders v2 create/capture flow for dropship-only carts.
- **Bank transfer / EFT**: optional manual payment method. Orders remain pending until an admin verifies the transfer and marks the order paid.
- **Marketplace commission**: `MARKETPLACE_COMMISSION_PERCENT` (default 10%) is calculated on marketplace merchandise sales.
- **Stripe Connect seller onboarding + payouts**: marketplace sellers connect a verified Express payout account. Stripe marketplace payments can be split from the platform to multiple sellers after payment succeeds.
- **Owner payout guidance**: Admin Settings links to Stripe/PayPal payout settings. Raw bank/card numbers are intentionally never stored by SANDMAN.
- **Syncee supplier mode**: a truthful manual fulfillment bridge for a custom SANDMAN retailer. The admin can add `SYNCEE` suppliers, open Syncee for supplier payment/forwarding, and save tracking back in SANDMAN.
- **Favicon**: simple SANDMAN eye/star favicon based on the brand mark.

## Required Railway variables

Keep the existing variables and add whichever integrations you use:

```env
JWT_EXPIRES_IN=2h
SESSION_DAYS=90

STRIPE_SECRET_KEY=
STRIPE_PUBLISHABLE_KEY=
STRIPE_WEBHOOK_SECRET=

PAYPAL_CLIENT_ID=
PAYPAL_CLIENT_SECRET=
PAYPAL_MODE=sandbox

BANK_TRANSFER_INSTRUCTIONS=
MARKETPLACE_COMMISSION_PERCENT=10
MARKETPLACE_PAYOUT_DELAY_DAYS=0

SYNCEE_ORDERS_URL=https://syncee.com
SYNCEE_MODE=manual
```

## Stripe webhook

Create a Stripe webhook endpoint pointing to:

```text
https://YOUR-SANDMAN-DOMAIN/api/webhooks/stripe
```

At minimum subscribe to:

- `payment_intent.succeeded`
- `payment_intent.payment_failed`

Then put the signing secret in `STRIPE_WEBHOOK_SECRET`.

## Marketplace payouts

Seller flow:

1. Seller logs in.
2. Seller opens **Seller dashboard → Payouts**.
3. Seller starts Stripe Connect onboarding.
4. Stripe securely collects identity + payout details.
5. Seller returns to SANDMAN and SANDMAN refreshes payout status.
6. Seller accepts the SANDMAN commission and publishes a listing.
7. Buyer pays a marketplace cart through Stripe.
8. SANDMAN records its commission and transfers the seller net amount to the seller's connected Stripe account.

SANDMAN intentionally does **not** accept raw bank account or payout debit-card details directly.

## Syncee workflow

Syncee's public custom-platform documentation currently exposes supplier-side order webhooks, not a public retailer-side catalog/order submission API for arbitrary custom stores. V1.3 therefore does not fake an undocumented API.

For SANDMAN products linked to a `SYNCEE` supplier:

1. Customer payment succeeds.
2. SANDMAN creates a Syncee fulfillment handoff and keeps the order in processing.
3. Admin opens **Fulfillment → SYNCEE**.
4. Admin completes the supplier payment/forwarding inside Syncee.
5. Admin enters the carrier/tracking number back into SANDMAN.

If Syncee grants your account a private/custom retailer API later, the `SynceeSupplierAdapter` is the single place to replace the manual handoff with true API submission.

## V1.3.1 hardening
- Marketplace inventory is atomically reserved at checkout and restored if payment initialization fails.
- Stripe webhook events verify PaymentIntent id, order amount, currency and provider before fulfillment.
- PayPal capture verifies SANDMAN order identity, invoice and captured amount.
- Seller payouts are prepared at payment time but only become transferable after seller shipment.
- Stripe Connect transfers use idempotency keys and can be retried from the admin API.
- Supplier fulfillment is unique per order/supplier and failed submissions can be retried.
- Mixed marketplace + dropship order status is recomputed consistently.
- Access JWTs stay in memory; persistent login uses a Secure/HttpOnly refresh-session cookie.
- Logout/password changes revoke server-side sessions so old access tokens stop working.
