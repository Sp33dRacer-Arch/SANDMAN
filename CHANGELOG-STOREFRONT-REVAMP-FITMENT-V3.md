# SANDMAN V2.6.1 — Storefront Revamp + Fitment V3

Keeps the existing SANDMAN visual design while repairing storefront behavior, image handling, search ranking, Vinyasa home merchandising, and vehicle/fitment wiring.

## Storefront
- Fixes shop page changes so the selected `page` parameter is preserved.
- Adds bounded Previous / Next + five-page pagination that stays safe for very large catalogues.
- Replaces direct `location.hash` assignments in storefront actions with the existing clean History API navigation path.
- Fixes the Messages conversation selector so every conversation button is bound, not only the first one.
- Adds graceful product-image fallback when a remote image URL fails.
- Adds a Vinyasa connected-catalogue section to the home page using active Vinyasa listings that have ProductImage rows.

## Search
- Keeps exact SKU / manufacturer part number / exact product-name matches ahead of broad matches.
- Gives photographed products a relevance bonus instead of letting any image-bearing low-relevance result blindly outrank a much better text match.
- Search suggestions also favor image-bearing products while retaining exact part-number priority.

## Vinyasa fitment
- Normalizes Vinyasa's documented singular `fitment` object plus `applications` text.
- Supports make/model/year/engine axes and retains legacy structured fitment arrays.
- Hard-caps fitment expansion to 250 normalized rows per supplier product to prevent axis explosions.
- Supports Vinyasa `after` cursors and preserves the existing `available_qty` stock fix.
- Creates unverified `SUPPLIER` ProductFitment evidence only from supplier data; unknown fitment remains UNKNOWN rather than being guessed.

## Vehicle catalogue
- Bootstraps the bundled `data/sandman-global-vehicles.json` catalogue when the curated dataset is not actually present.
- Preserves curated engine codes such as B58 and N55 instead of converting every curated row to `UNSPECIFIED`.
- Runs the curated vehicle bootstrap before the Vinyasa automatic scheduler begins, removing the prior startup race.

## V3 corrections over the unreleased V2 revamp
- Fixed the `$$(...)` multi-element Messages selector being collapsed to `$(...)` by JavaScript string-replacement semantics.
- Fixed the Vinyasa scheduler starting before vehicle-catalogue bootstrap completed.
- Fixed curated engine values being discarded.
- Added fitment normalization hard caps.
- Changed broad search image priority from a hard override to a relevance-safe weighted bonus.
- Made the V3 installer idempotent and able to repair a previously applied V2 revamp.

## Safety
- No `.env` or Railway secret is changed.
- No Prisma schema or migration is added or changed.
- No payment configuration is changed.
- Vinyasa order submission is not enabled.

## Automatic product SEO layer
- Adds automatic SEO metadata for every ACTIVE product without a database backfill.
- Keeps manually supplied `seoTitle` and `seoDescription` as the highest-priority values.
- Generates a bounded fallback title from brand + product name + manufacturer part number/SKU so products do not all share generic titles.
- Generates a bounded fallback description from product copy and category context.
- Server-renders canonical, robots, Open Graph, Twitter and product price/currency/availability metadata on direct product URLs.
- Adds Schema.org `Product` + `Offer`, `BreadcrumbList`, and site `SearchAction` JSON-LD.
- Escapes JSON-LD before HTML injection.
- Marks missing product pages `noindex,follow`.
- Replaces the former 49,980-product sitemap ceiling with a sitemap index and 45,000-product child sitemaps so the entire active catalogue can be discoverable.
- Refreshes title/canonical/Open Graph/Twitter metadata during client-side route changes.
- Does not bulk-write SEO fields, add a migration, or increase Postgres usage with an SEO backfill.


## Error-scan hardening — 2026-09-09

A deeper post-SEO scan found and corrected four edge cases that the original static audits did not cover:

1. Legacy Vinyasa-imported SEO fields looked like manual overrides, so automatic part-number/SKU SEO could be bypassed. The SEO service now ignores only the exact old supplier-generated pattern while preserving genuine custom SEO.
2. SPA navigation could leave the previous product image, product price tags, or product JSON-LD in the document. Client metadata now resets stale tags and rebuilds Product/Breadcrumb schema for the active product.
3. Generic make/model/year supplier fitment could resolve only an `UNSPECIFIED` synthetic variant and miss existing engine-coded Garage variants. It now maps to all curated variants fully covered by the supplier year range; partial-year matches are intentionally not guessed.
4. Vinyasa fitment synchronization was append-only. A new resolvable supplier set now refreshes only old unverified Vinyasa-generated rows, while manual and verified fitment evidence is preserved.

No database migration, bulk SEO rewrite, payment change, order-submission change, or secret change is included.
