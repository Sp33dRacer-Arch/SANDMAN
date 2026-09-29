# SANDMAN V3.1.5 — Lean-Storage Hardening Worker Compatibility Fix

V3.1.5 fixes the V3.1.4 compatibility failure where the live backend used a different but still correct stock/price synchronization block, causing the installer to abort on an exact sparse-write marker.

## Fixed
- Treats sparse stock/price write optimization as a compatibility-aware enhancement: known layouts are optimized; unknown layouts are preserved if V2.6.1 stock correctness can still be verified.
- Removes the mandatory exact sparse-write marker that caused the V3.1.4 `expected one marker, found 0` failure.
- Supports the newer `startVinyasaCatalogJob` / `processVinyasaCatalogJobBatch` worker.
- Supports the legacy live `startVinyasaImportJob` / `resumeVinyasaImportJob` worker used by the user's backend.
- Locates functions by function name/declaration shape instead of one exact exported signature.
- Keeps full catalogue growth behind the PostgreSQL database-size safety guard.
- Rechecks storage before every non-stock-price background catalogue batch, so a long import cannot grow past the guard after starting below it.
- Never blocks direct or background `STOCK_PRICE` synchronization because fresh inventory/pricing is commerce-safety critical.
- Keeps image repair guarded at job start and again per image-repair batch.
- Remains idempotent: a second application adds no duplicate guards or rewrites.
- Retains the earlier lean-storage fixes: active-product view validation, strict 50-item recently-viewed pruning, raw supplier payload removal, dynamic SEO, sparse image/fitment writes and conditional supplier stock snapshots. A bounded `lastSyncedAt` heartbeat is applied only when the stock-sync layout is recognized safely.

No Prisma migration, `.env`, secret, payment setting, supplier-order setting or destructive bulk database cleanup is included.
