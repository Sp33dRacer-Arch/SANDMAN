# SANDMAN V2.6 — Vinyasa Commerce

V2.6 adds a server-side Vinyasa dealer/reseller integration to the existing PayPal-first SANDMAN backend.

## Catalogue + product data
- Vinyasa supplier card opens a management console.
- API connectivity test with safe GET-only catalogue endpoint discovery.
- Live-feed preview before importing anything.
- Bulk full-catalogue import with SKU/product upserts instead of duplicates.
- Stock + dealer-cost + supplier-RRP synchronization.
- Product images, descriptions, brands, MPNs, categories, dimensions, shipping data, warranty/returns, customs data, technical specifications, video URLs and available supplier fitment data are normalized when supplied by the feed.
- Unknown or unsupported feed fields remain preserved in SupplierProduct.rawData for inspection.
- Zero-cost products and settlement-currency mismatches fail closed instead of being silently published.

## Profit pricing
- Configurable automatic markup floor/ceiling: 10% to 800%.
- Vinyasa RRP/MSRP can be preferred when it is inside your guardrails.
- Adaptive pricing tiers: low-cost, mid-cost and high-cost markups are configurable.
- Existing SANDMAN category/supplier PricingRule records override generic supplier RRP when explicitly configured.
- Per-product markup override or fixed-retail override.
- Price endings: .99, .95, whole amount or no rounding.
- Admin shows landed dealer cost, Vinyasa RRP, recommended SANDMAN retail, current retail, gross profit, margin and markup.

## Paid order handoff + tracking
- After SANDMAN confirms a customer payment, existing fulfillment routing can submit Vinyasa dropship items through the Vinyasa adapter.
- Supplier payment mode is configurable as Vinyasa wallet, card on file or manual.
- Order submission uses idempotency headers and preserves the supplier response.
- Vinyasa tracking/status can be refreshed manually and is also polled by automatic Vinyasa sync when enabled.
- Shipping/delivery transitions update SANDMAN fulfillment state and customer notifications/email.

## Automation + security
- Server-only VINYASA_API_KEY support with Bearer or X-API-Key authentication.
- Separate SANDMAN_VINYASA_SYNC_API_KEY protects the external sync endpoint.
- Automatic sync interval is configurable from Admin once the Vinyasa key is present.
- Full import, stock/price sync, tracking sync and repricing are available from Admin.
- API secrets are never returned to or embedded in the browser bundle.

## Live certification still required
The source integration is designed around the Vinyasa reseller API information supplied to SANDMAN, but a real dealer credential is required to certify the exact live catalogue and order payloads. Use **Test Vinyasa API** and **Preview feed** before a full import, then test one controlled paid supplier order before relying on automatic fulfillment in production.
