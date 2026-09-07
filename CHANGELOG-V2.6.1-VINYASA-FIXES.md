# SANDMAN V2.6.1 — Vinyasa hardening

Fixes from the V2.6 deep scan:
- persistent resumable background catalogue jobs for large 180k+ feeds
- 500,000 default / 1,000,000 configurable import ceiling
- stock-only sync always updates buyer-facing Product.stockQuantity
- unknown Vinyasa stock fails closed at zero availability and disables that supplier link
- numeric inventory fields are normalized
- Vinyasa API paths are restricted to relative paths on VINYASA_BASE_URL
- supplier money units must be explicitly confirmed as MAJOR or MINOR before import
- order submission is disabled until the authenticated Vinyasa order contract is confirmed
- explicit CAMEL/SNAKE order payload mode removes unsafe retry/fallback ambiguity
- missing-product deactivation only runs after a clean completed full feed
- sync lease duration is independent of the configured sync interval
- admin import returns immediately and runs as a resumable background job

Live Vinyasa order creation and tracking still require an authenticated end-to-end test with the real dealer API before launch certification.
