import { describe, expect, it } from 'vitest';
import { computeActiveOrderFulfillmentStatus } from '../src/lib/fulfillment-status';

describe('computeActiveOrderFulfillmentStatus', () => {
  it('does not count a shipped fulfillment from a fully-refunded supplier', () => {
    expect(computeActiveOrderFulfillmentStatus({
      marketplaceOpenLines: 1,
      marketplaceShippedLines: 0,
      activeDropshipSupplierIds: ['supplier-live'],
      shippedDropshipSupplierIds: ['supplier-refunded'],
    })).toBe('PROCESSING');
  });

  it('counts only active shipped suppliers in a mixed order', () => {
    expect(computeActiveOrderFulfillmentStatus({
      marketplaceOpenLines: 1,
      marketplaceShippedLines: 1,
      activeDropshipSupplierIds: ['supplier-live'],
      shippedDropshipSupplierIds: ['supplier-refunded', 'supplier-live'],
    })).toBe('FULFILLED');
  });

  it('marks dropship-only unshipped orders as submitted', () => {
    expect(computeActiveOrderFulfillmentStatus({
      marketplaceOpenLines: 0,
      marketplaceShippedLines: 0,
      activeDropshipSupplierIds: ['supplier-live'],
      shippedDropshipSupplierIds: [],
    })).toBe('SUBMITTED_TO_SUPPLIER');
  });
});
