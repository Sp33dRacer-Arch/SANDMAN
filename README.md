# SANDMAN V2.3

SANDMAN is a custom automotive-parts commerce platform: storefront, marketplace, My Garage, exact vehicle fitment, builds, supplier routing, checkout, payments, reviews, support and admin operations.

V2.3 keeps the vehicle as a first-class part of shopping and adds a growth/trust layer: clean public URLs, VIN-assisted vehicle resolution, ranked search, delivery estimates and tracking, seller reputation, verified photo reviews, returns/buyer-protection workflows, and stronger Garage personalization.

## V2.3 highlights

- Clean History API storefront URLs, product canonical/OG metadata, `robots.txt`, and dynamic product `sitemap.xml`.
- VIN-assisted Garage lookup using NHTSA vPIC, with conservative SANDMAN catalogue matching and explicit customer confirmation.
- Ranked search that prioritizes exact SKU/MPN/name matches before broad text matches.
- Product delivery estimates plus carrier-aware tracking links on customer orders.
- Seller reputation summaries with verified, top-seller and experience badges based on transaction/review evidence; seller response time is shown only as a self-declared response goal, not a performance badge.
- Verified-purchase reviews with up to 5 photos and purchase-vehicle context.
- Returns Center with order/item selection, evidence uploads and existing buyer-protection/refund operations.
- Primary Garage vehicle prompts that personalize shopping without silently hiding unrelated inventory.
- Step-by-step Vehicle Finder: make → model → year → engine/variant.
- Verified fitment evidence on `ProductFitment` with source and verification timestamp.
- Safer fitment semantics: missing catalogue evidence is **unconfirmed**, not automatically “does not fit”.
- Vehicle-aware product search and exact-variant shopping.
- Checkout preflight for vehicle selection, fitment evidence and stock.
- Missing vehicle + missing part sourcing requests.
- Admin Sourcing Desk with catalogue-health metrics and request workflow.
- Deterministic Build Advisor for Daily, Reliability, Street and Track goals.
- Build targets now support horsepower, torque, budget and goal.
- Supplier metadata for warehouse country, lead time and reliability score.
- Supplier feed/operations ingestion of the new metadata.
- Corrected vehicle-catalogue importer for the real `VehicleMake -> VehicleModel -> VehicleVariant` schema.
- Curated vehicle dataset + NHTSA importer tooling included.

## Core API additions

V2 endpoints are mounted under `/api/v2`.

- `GET /api/v2/catalog/status`
- `POST /api/v2/vin/decode`
- `GET /api/v2/shipping-estimate/:productId`
- `GET /api/v2/vehicles/picker`
- `GET /api/v2/vehicles/resolve`
- `GET /api/v2/search`
- `GET /api/v2/fitment/check`
- `POST /api/v2/fitment/check-batch`
- `GET /api/v2/products/:id/supplier-options`
- `GET /api/v2/checkout/preflight`
- `POST /api/v2/requests/vehicle`
- `POST /api/v2/requests/part`
- `GET /api/v2/requests/mine`
- `GET /api/v2/dashboard`
- `POST /api/v2/build-advisor`
- Admin catalogue-health and sourcing-request endpoints.

Existing `/api/products`, `/api/builds`, `/api/admin`, checkout, payments and marketplace routes remain in place. Product and build fitment responses now use the safer V2 fitment evaluator.

## Fitment rule

A product can be:

- `UNIVERSAL` — no vehicle-specific selection required.
- `VERIFIED_FIT` — an exact variant link exists and has been verified.
- `CATALOG_FIT` — an exact variant link exists but is not yet manually verified.
- `UNKNOWN` — no exact fitment evidence is present.
- `DOES_NOT_FIT` — reserved for explicit incompatibility evidence; catalogue absence alone is not treated as proof of incompatibility.

This distinction matters: SANDMAN should never invent compatibility just to make a sale.

## Local verification

From the project root:

```powershell
npm install
npx prisma generate
npx prisma validate
npm run typecheck
npm test
npm run build
```

Or run:

```powershell
.\VERIFY-V2.3.ps1
```

Never commit `.env`.

## Database migration

V2.3 adds **no new Prisma schema or migration**. It reuses the existing V2.2/V2.0 data model. The latest automotive-core migration already present is:

`prisma/migrations/20260831110000_v20_vehicle_fitment_requests/migration.sql`

For production/Railway use **deploy**, not development migration commands:

```text
npm run prisma:deploy
```

Do **not** run `prisma migrate dev` against the production Railway database.

## Railway

Recommended service commands:

- Build: `npm run prisma:generate && npm run build`
- Pre-deploy: `npm run prisma:deploy`
- Start: `node dist/src/server.js`
- Health: `/api/health`

After the existing V2 migration chain is successfully deployed, the vehicle catalogue can be populated **inside the Railway service environment**. Start with BMW only:

```bash
node scripts/sync-vehicle-catalog.mjs --source=curated --only-make=BMW --from=1996 --to=2027
node scripts/vehicle-catalog-check.mjs
```

Only expand to the full catalogue after the BMW smoke test succeeds.

## Still external / later-stage work

V2.3 still does not pretend to include services that require external providers or validated engineering data. You still need real supplier/API credentials, Stripe/PayPal configuration, outbound email, Cloudinary/object storage and operational/legal setup. NHTSA VIN decoding is assistive only and never replaces SANDMAN fitment evidence. A generative AI mechanic, OEM diagram licensing and 3D engineering simulation remain later phases.

## Production safety

- Never put payment keys, JWT secrets, supplier secrets or database credentials in source control.
- Do not run demo seeds in production unless intentionally enabled.
- Treat imported fitment as catalogue evidence, not automatically verified fitment.
- Do not expose supplier cost or raw supplier feed payloads in public responses.
- Test payment/refund/fulfillment workflows in sandbox or staging before production.
- VIN lookups are sent by POST so VINs are not placed in access-log URLs; decoded data is assistive and the customer must confirm the catalogue variant.
- When your custom domain becomes active, set Railway `APP_URL` (and normally `API_URL`) to that canonical HTTPS domain before relying on SEO metadata, email links or Stripe Connect return URLs.
