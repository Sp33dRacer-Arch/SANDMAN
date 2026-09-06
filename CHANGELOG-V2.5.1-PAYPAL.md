# SANDMAN V2.5.1 — PayPal-first checkout

- PayPal is now the default and first-listed checkout option for direct/dropship orders.
- Added idempotent PayPal create/capture/refund requests using `PayPal-Request-Id`.
- Added OAuth token caching and API request timeouts.
- Added merchant-provided physical shipping address to PayPal Orders v2.
- Added `paypalCaptureId` persistence and a non-destructive migration.
- Added raw-body cryptographic PayPal webhook verification and webhook deduplication.
- Added capture-completed recovery/finalization plus pending/denied/reversed handling.
- Hardened browser PayPal Buttons approval, cancel, error and eligibility behavior.
- Added PayPal-first launch readiness rules and static PayPal audit.
- Stripe remains optional for ordinary checkout and remains the current seller-marketplace payout path.
