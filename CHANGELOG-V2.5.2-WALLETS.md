# SANDMAN V2.5.2 — PayPal + Wallets

- Removed Stripe from the customer-facing storefront checkout and payment configuration.
- Customer checkout now uses PayPal or optional bank/EFT only.
- Added Google Pay and Apple Pay through PayPal's JavaScript SDK components.
- Wallet buttons are eligibility-gated and remain hidden when PayPal, the browser, device, country or merchant account is not eligible.
- Added Google Pay 3DS payer-action handling before server capture.
- Added Apple Pay merchant validation and native Apple Pay session handling.
- Added the required `/.well-known/apple-developer-merchantid-domain-association` server path; it returns 404 until the PayPal-provided domain-association file is placed at `public/apple-developer-merchantid-domain-association`.
- Removed Stripe browser origins from the Content Security Policy and added PayPal/Google/Apple wallet origins.
- Marketplace checkout is intentionally paused until a PayPal-compatible multiparty seller-payout flow is approved and implemented.
- Legacy Stripe backend/webhook code is left in place only for historical compatibility; it is not offered by the website checkout.
