import { describe, expect, it } from 'vitest';
import { effectiveOfferUnitPrice } from '../src/lib/offer-pricing';

describe('effectiveOfferUnitPrice', () => {
  it('uses an accepted negotiated price for exactly one unit', () => {
    expect(effectiveOfferUnitPrice({
      productPriceCents: 10000,
      quantity: 1,
      offer: { status: 'ACCEPTED', amountCents: 8000 },
    })).toBe(8000);
  });

  it('never multiplies a negotiated unit price across extra quantity', () => {
    expect(effectiveOfferUnitPrice({
      productPriceCents: 10000,
      quantity: 2,
      offer: { status: 'ACCEPTED', amountCents: 8000 },
    })).toBe(10000);
  });
});
