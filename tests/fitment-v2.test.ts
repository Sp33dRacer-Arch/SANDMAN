import { describe, expect, it } from 'vitest';
import { evaluateFitment } from '../src/services/fitment.service';

const base = {
  requiresFitment: true,
  isUniversal: false,
  fitments: [] as Array<{ vehicleVariantId: string; verified?: boolean; source?: string }>,
};

describe('SANDMAN V2 fitment evaluation', () => {
  it('treats universal products as compatible without a vehicle', () => {
    expect(evaluateFitment({ ...base, isUniversal: true }, null)).toMatchObject({
      status: 'UNIVERSAL', fits: true, verified: true,
    });
  });

  it('requires a vehicle before evaluating vehicle-specific parts', () => {
    expect(evaluateFitment(base, null)).toMatchObject({
      status: 'UNKNOWN', fits: null, verified: false,
    });
  });

  it('does not claim incompatibility just because catalogue evidence is missing', () => {
    expect(evaluateFitment(base, 'vehicle-1')).toMatchObject({
      status: 'UNKNOWN', fits: null, verified: false,
    });
  });

  it('distinguishes catalogue fitment from verified fitment', () => {
    const catalog = evaluateFitment({ ...base, fitments: [{ vehicleVariantId: 'vehicle-1', verified: false, source: 'IMPORTED' }] }, 'vehicle-1');
    const verified = evaluateFitment({ ...base, fitments: [{ vehicleVariantId: 'vehicle-1', verified: true, source: 'OEM' }] }, 'vehicle-1');
    expect(catalog).toMatchObject({ status: 'CATALOG_FIT', fits: true, verified: false });
    expect(verified).toMatchObject({ status: 'VERIFIED_FIT', fits: true, verified: true });
  });
});
