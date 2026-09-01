import { describe, expect, it } from 'vitest';
import { deliveryWindow, trackingUrlFor } from '../src/services/shipping.service';

describe('shipping helpers', () => {
  it('creates known carrier tracking links', () => {
    expect(trackingUrlFor('DHL Express', 'ABC 123')).toContain('tracking-id=ABC%20123');
  });
  it('prefers explicit product delivery windows', () => {
    expect(deliveryWindow({ productMinDays: 2, productMaxDays: 5, supplierLeadTimes: [8] })).toEqual({ minDays: 2, maxDays: 5, source: 'PRODUCT' });
  });
});
