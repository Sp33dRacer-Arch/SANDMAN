import { describe, expect, it } from 'vitest';
import { calculateOrderTotals } from '../src/lib/money';

describe('calculateOrderTotals', () => {
  it('applies flat shipping below the threshold', () => {
    expect(calculateOrderTotals({
      subtotalCents: 10000,
      freeShippingThresholdCents: 25000,
      flatShippingCents: 1800,
      taxRate: 0,
    })).toEqual({ subtotalCents: 10000, discountCents: 0, shippingCents: 1800, taxCents: 0, totalCents: 11800 });
  });

  it('makes shipping free at the threshold', () => {
    expect(calculateOrderTotals({
      subtotalCents: 30000,
      freeShippingThresholdCents: 25000,
      flatShippingCents: 1800,
      taxRate: 0.1,
    }).totalCents).toBe(33000);
  });
});
