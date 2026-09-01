# SANDMAN V2.3 — Growth & Trust

V2.3 upgrades the existing SANDMAN project in place. It does not rewrite checkout, payments, marketplace inventory, supplier routing, Prisma schema, or the fitment model.

## Growth
- Clean History API public routes and canonical product URLs.
- Server-side product title/description/Open Graph metadata.
- `robots.txt` and cached product sitemap.
- Ranked product search with exact SKU/MPN/name priority.
- VIN-assisted vehicle lookup using NHTSA vPIC with conservative SANDMAN catalogue matching.
- Primary-Garage personalization prompts.

## Trust & post-purchase
- Product shipping estimates.
- Carrier-aware tracking links for supplier and marketplace shipments.
- Customer order progress timeline.
- Seller reputation based on verified reviews and paid transaction lines.
- Verified-purchase product reviews with up to five uploaded photos and purchase-vehicle context.
- Returns Center using the existing buyer-protection/refund workflow, with evidence uploads.
- Admin evidence viewer for buyer-protection cases.

## Performance / API shape
- Product listing responses use one listing image, aggregate ratings, selected-vehicle fitment evidence, and derived stock rather than loading every review/fitment row.
- Search suggestions are debounced/cancellable in the storefront and relevance-ranked on the server.

## Post-scan fixes
- Marketplace clean URL now resolves to the marketplace-filtered shop instead of a storefront 404.
- VIN moved from a GET path to `POST /api/v2/vin/decode` so the full VIN is not written into ordinary URL/access logs; VIN responses are `no-store`.
- NHTSA decode warnings prevent an automatic high-confidence catalogue match.
- VIN endpoint has a tighter route-level rate limit.
- Out-of-stock supplier links are excluded from delivery estimates.
- Sitemap URL count is kept below the 50,000-URL protocol limit.
- Missing products return HTTP 404 while still rendering the SANDMAN storefront shell.
- `robots.txt` no longer blocks public `/sellers/...` profiles by accidentally prefix-matching `/seller`.
- Review/return evidence is restricted to SANDMAN's signed Cloudinary delivery path rather than arbitrary third-party image hosts.
- Customer order tracking no longer exposes connected supplier identity.
- Blank optional email-webhook/supplier-secret values in `.env` no longer fail environment validation.
- Seller reputation no longer presents a seller-entered response goal as an evidence-based fast-response badge.
- Seller sales badges use verified paid transaction lines rather than quantity units.
- Fulfillment copy no longer calls `FULFILLED` carrier-confirmed delivery; it is described as shipped/fulfilled.

## Database
V2.3 adds no Prisma migration. `prisma/schema.prisma` is unchanged from the V2.2 baseline.

## Final audit hardening

- Public product and seller reviews now return explicit buyer-safe DTOs instead of Prisma rows, preventing foreign-key/order-item identifiers from leaking.
- Public product seller profiles omit internal profile IDs and userId foreign keys.
- The public supplier-options endpoint no longer exposes supplier identity/code, internal supplier-link IDs, exact supplier stock, reliability scores, or sync timestamps.
- Admin product fitment uses a single mutually-exclusive Vehicle-specific / Universal mode, with matching backend validation to prevent inconsistent flags.
- Seller listing fitment search remains full-catalogue based; incomplete drafts are allowed, while publication requires a valid compatible vehicle selection or explicit Universal mode.
