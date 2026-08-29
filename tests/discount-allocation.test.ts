import { describe, expect, it } from 'vitest';
import { allocateDiscountCents } from '../src/lib/discount-allocation';

describe('allocateDiscountCents', () => {
  it('never over-discounts a tiny last line', () => {
    const result = allocateDiscountCents([
      { id: 'a', totalCents: 1 },
      { id: 'b', totalCents: 1 },
      { id: 'c', totalCents: 1 },
    ], 2);
    const amounts = [...result.values()];
    expect(amounts.reduce((sum, value) => sum + value, 0)).toBe(2);
    expect(amounts.every(value => value >= 0 && value <= 1)).toBe(true);
  });

  it('allocates the exact capped discount', () => {
    const result = allocateDiscountCents([
      { id: 'turbo', totalCents: 10000 },
      { id: 'gasket', totalCents: 2500 },
      { id: 'bolts', totalCents: 700 },
    ], 3333);
    expect([...result.values()].reduce((sum, value) => sum + value, 0)).toBe(3333);
    expect(result.get('turbo')!).toBeLessThanOrEqual(10000);
    expect(result.get('gasket')!).toBeLessThanOrEqual(2500);
    expect(result.get('bolts')!).toBeLessThanOrEqual(700);
  });
});
