# SANDMAN V3.1.3 — Lean-Storage Hardening Compatibility Fix

V3.1.3 fixes installer compatibility problems found while applying V3.1.1/V3.1.2 to the live SANDMAN backend.

## Fixed
- Replaced brittle whole-block matching for storage guards with structural function-level patching.
- Supports valid Vinyasa code shapes created by the V5 money-unit hotfix.
- Supports backends where the old pre-sync guard marker is absent or formatted differently.
- Keeps full catalogue imports and image-repair growth behind the PostgreSQL size guard.
- Never blocks direct `STOCK_PRICE` synchronization because fresh stock is commerce-safety critical.
- Never blocks background `STOCK_PRICE` catalogue jobs; only FULL growth jobs are size-guarded.
- Remains idempotent: rerunning the patcher does not duplicate guards or rewrites.
- Retains V3.1.2 fixes for active-product validation, 50-item recent-history pruning, bounded `lastSyncedAt` heartbeat, sparse supplier writes, sparse image/fitment refresh, raw payload removal and dynamic SEO.

No Prisma migration, `.env`, payment setting, supplier-order setting or destructive bulk database cleanup is included.
