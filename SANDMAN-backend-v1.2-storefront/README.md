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
- PayPal gateway
- Refund/return/RMA workflow
- Coupons and promotions
- Product reviews
- Email/SMS transactional notifications
- Background job queue (BullMQ/Redis) for supplier submission and tracking
- Object storage for product media
- Observability and audit logs
- Admin web dashboard

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
