# SANDMAN V3.1.1 — Lean-Storage Hardening Fixed

This is the corrected cumulative build of V3.1 lean-storage hardening.

## V3.1.1 fixes
- Storage pressure no longer blocks Vinyasa `STOCK_PRICE` synchronization. Catalogue growth and image-repair jobs remain guarded.
- Anonymous `/products/:id/view` requests now validate that the product exists and is ACTIVE before returning 204, restoring 404 semantics without reintroducing anonymous writes.
- `SupplierProduct.lastSyncedAt` now receives a bounded six-hour heartbeat even when supplier values are unchanged, avoiding indefinitely stale freshness metadata while remaining write-sparse.
- Recently-viewed cleanup no longer stops after 200 overflow rows; authenticated views prune history to the newest 50 rows.
- Static verification now checks the actual guard behavior, route ordering, cleanup ceiling, sync heartbeat, and patch target list instead of using a hard-coded migration pass.
- Patcher supports both the pre-lean V3 state and repair of the original V3.1 lean-storage state.

## Preserved lean-storage behavior
- Full Vinyasa raw payloads are not persisted in `SupplierProduct.rawData`.
- Importer-generated duplicate SEO fields are not persisted; V3 dynamic SEO remains authoritative.
- Product images and supplier fitment rows avoid delete/recreate churn when unchanged.
- Lean background catalogue batches default to 500 products.
- Anonymous product views remain write-free.
- Signed-in view counters/recent timestamps refresh at most once per product every six hours.

## No changes to
- Prisma schema or migrations
- `.env` or secrets
- payments or supplier-order submission
- dependencies or media assets
