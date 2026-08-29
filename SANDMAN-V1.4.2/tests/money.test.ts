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

it('caps a discount at the subtotal', () => {
  expect(calculateOrderTotals({
    subtotalCents: 1000,
    freeShippingThresholdCents: 25000,
    flatShippingCents: 0,
    taxRate: 0,
    discountCents: 5000,
  })).toEqual({ subtotalCents: 1000, discountCents: 1000, shippingCents: 0, taxCents: 0, totalCents: 0 });
});
