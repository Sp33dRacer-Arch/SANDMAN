# SANDMAN V2.6.1 — Storefront UX + Vinyasa 5M / Image Repair

Cumulative patch containing the storefront/mobile UX work plus Vinyasa scale and media repair changes.

## Storefront / mobile
- De-bunched desktop navigation and earlier responsive collapse.
- Cleaner mobile header/menu, 44px touch targets and safe-area handling.
- Long search/product headings wrap safely.
- Improved automotive image fitting and multi-shape API image extraction.
- Search/menu accessibility state and outside/Escape closing fixes.
- Branded SANDMAN `IMAGE UNAVAILABLE` fallback instead of a tiny glyph.

## Vinyasa
- Raises the configurable import safety ceiling to **5,000,000** while keeping page size capped at 500.
- Preserves/repairs `available_qty` / `in_stock` stock normalization.
- Uses Vinyasa's documented `after` cursor for resumable catalogue pagination when a cursor is returned.
- Adds a **Repair missing images** admin action.
- Missing-image repair is persistent/resumable using the existing background-job state.
- It targets active Vinyasa-linked products with no product image.
- It first reads any images already present in the stored supplier payload.
- It calls `/products/{product_id}` only when the stored payload has no image.
- Product-detail requests are sequential/rate-limited to about 109 requests/minute.
- Products with no supplier image remain valid and receive the storefront fallback.

## Safety
- The backend change is applied by a source-aware script against the user's current workspace instead of blindly replacing current Vinyasa source files.
- The script aborts if required source markers do not match.
- No `.env`, Railway secret, payment configuration, or database migration is changed.
