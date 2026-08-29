# SANDMAN V1.4.2 changelog

## Final V1.4.2 audit fixes

- Added a final checkout guard that rejects accepted-offer cart lines unless quantity is exactly 1.
- Cart price display also refuses to apply an accepted-offer price to a quantity greater than 1.
- Fixed mixed-order fulfillment counting so shipped fulfillments from a fully-refunded supplier no longer make an order appear fulfilled early.
- Added `SupplierProduct.reservedStock` and `SupplierProduct.availableStock`.
- Added atomic supplier inventory reservation at checkout.
- Added per-order-item supplier reservation audit fields: link id, reserved time, released time and committed time.
- Checkout rollback/cancellation/expiration now restores both marketplace stock and supplier reservations.
- Bank-transfer checkout cleanup now releases dropship holds after the longer configured hold window.
- Supplier feed/import updates preserve reservations when recalculating available stock.
- Releasing a supplier hold now recalculates availability from the latest supplier-reported stock, so a stock feed change cannot accidentally recreate sold-out inventory.
- Public product/search/recommendation stock uses available supplier stock instead of raw reported stock.
- Supplier order submission commits local reservations only after the external supplier order has been persisted.
- Added a repair path for the rare case where supplier submission succeeds but local inventory commit is interrupted.
- Fully refunded dropship lines release any supplier reservation that was not yet committed.
- Refund handling now recomputes mixed-order fulfillment status after the refund.

## Preserved V1.4.1 hardening

V1.4.2 keeps V1.4.1's promo reservation, offer lifecycle, payment-finalization claims, abandoned Stripe checkout cleanup, refund lock, payout PROCESSING claim/idempotency, seller payout adjustments, PayPal refund idempotency, authentication/session hardening, 2FA protections, supplier-cost privacy and production seed guard.
