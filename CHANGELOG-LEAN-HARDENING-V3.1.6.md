# SANDMAN V3.1.6 — Lean-Storage Hardening Compatibility Fix

V3.1.6 supersedes V3.1.1 through V3.1.5.

## What changed from V3.1.5
- Adds native support for the legacy V2.6.1 `resumeVinyasaImportJob()` worker used by the current SANDMAN backend.
- Legacy FULL imports that previously passed `maxProducts: remaining` are now capped to `VINYASA_LEAN_BATCH_PRODUCTS` while lean mode is enabled.
- A capped legacy batch no longer gets incorrectly marked `LIMIT_REACHED` just because that individual batch ended before the supplier feed.
- The worker checks persisted `importJobProcessed` against the configured overall `maxImportProducts` safety ceiling.
- If more catalogue remains and the overall ceiling has not been reached, the job stays `RUNNING` and schedules the next resumable batch.
- Existing IMAGES handling remains unchanged and keeps its separate image-repair batch limit.
- Modern `processVinyasaCatalogJobBatch()` workers continue to use the existing lean batch cap.
- V3.1.5 compatibility-safe handling for unfamiliar stock/price write layouts is retained.

## Storage behavior retained
- no full Vinyasa `rawData` persistence
- dynamic storefront SEO instead of duplicated importer SEO
- sparse product image and fitment writes
- PostgreSQL logical database-size guard for growth-heavy catalogue/image operations
- STOCK_PRICE synchronization remains available even when the growth guard is reached
- per-page and per-background-batch storage rechecks
- low-write view/recent-history behavior
- conditional supplier-stock snapshots

## Safety
The patcher calculates all edits in memory and writes source files only after all required structural checks pass. It does not modify Prisma schema/migrations, `.env`, secrets, payment settings, supplier-order settings, or perform database cleanup.

Do not commit or deploy unless the complete local verifier ends with:

`SANDMAN V3.1.6 lean-storage hardening verification passed.`
