# SANDMAN V3.1.4 — Lean-Storage Hardening Worker Compatibility Fix

V3.1.4 fixes the V3.1.3 installer failure caused by SANDMAN having two valid generations of the Vinyasa background worker.

## Fixed
- Supports the newer `startVinyasaCatalogJob` / `processVinyasaCatalogJobBatch` worker.
- Supports the legacy live `startVinyasaImportJob` / `resumeVinyasaImportJob` worker used by the user's backend.
- Locates functions by function name/declaration shape instead of one exact exported signature.
- Keeps full catalogue growth behind the PostgreSQL database-size safety guard.
- Rechecks storage before every non-stock-price background catalogue batch, so a long import cannot grow past the guard after starting below it.
- Never blocks direct or background `STOCK_PRICE` synchronization because fresh inventory/pricing is commerce-safety critical.
- Keeps image repair guarded at job start and again per image-repair batch.
- Remains idempotent: a second application adds no duplicate guards or rewrites.
- Retains the earlier lean-storage fixes: active-product view validation, strict 50-item recently-viewed pruning, bounded `lastSyncedAt` heartbeat, sparse supplier/product/image/fitment writes, raw supplier payload removal and dynamic SEO.

No Prisma migration, `.env`, secret, payment setting, supplier-order setting or destructive bulk database cleanup is included.
