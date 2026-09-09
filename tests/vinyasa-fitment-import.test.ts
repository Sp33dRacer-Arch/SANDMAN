import { describe, expect, it } from 'vitest';
import { normalizeVinyasaProduct } from '../src/services/vinyasa-normalizer';

describe('Vinyasa documented images, stock and fitment', () => {
  it('normalizes the documented singular fitment axes and applications', () => {
    const row = normalizeVinyasaProduct({
      id: 'gtin:test-fitment',
      sku: 'FIT-100',
      title: 'Documented fitment part',
      price: '42.99',
      currency: 'USD',
      in_stock: true,
      available_qty: 12,
      image: 'https://cdn.vinyasapartners.com/p/FIT-100/main.jpg',
      images: [
        'https://cdn.vinyasapartners.com/p/FIT-100/main.jpg',
        'https://cdn.vinyasapartners.com/p/FIT-100/alt1.jpg',
      ],
      fitment: {
        make: ['Ford'],
        model: ['F-150'],
        year: ['2018', '2019'],
        engine: ['3.5L EcoBoost'],
      },
      applications: ['2018-2019 Ford F-150 3.5L EcoBoost'],
    });

    expect(row?.stockKnown).toBe(true);
    expect(row?.stock).toBe(12);
    expect(row?.images).toHaveLength(2);
    expect(row?.fitments.some(f => f.make === 'Ford' && f.model === 'F-150')).toBe(true);
    expect(row?.fitments.some(f => f.engineName === '3.5L EcoBoost')).toBe(true);
    expect(row?.fitments.some(f => f.applicationText?.includes('Ford F-150'))).toBe(true);
  });

  it('accepts legacy structured fitment arrays without regressing them', () => {
    const row = normalizeVinyasaProduct({
      id: 'legacy-fitment',
      sku: 'LEG-100',
      title: 'Legacy fitment part',
      price: '10.00',
      inventory: 2,
      fitments: [{ engineCode: 'B58B30M0', yearStart: 2016, yearEnd: 2019 }],
    });
    expect(row?.fitments[0]).toMatchObject({ engineCode: 'B58B30M0', yearStart: 2016, yearEnd: 2019 });
  });

  it('caps oversized fitment axes so one supplier row cannot explode in memory', () => {
    const models = Array.from({ length: 20 }, (_, i) => `Model ${i + 1}`);
    const years = Array.from({ length: 80 }, (_, i) => String(1940 + i));
    const engines = Array.from({ length: 80 }, (_, i) => `ENG-${i + 1}`);
    const row = normalizeVinyasaProduct({
      id: 'fitment-cap',
      sku: 'FIT-CAP',
      title: 'Oversized fitment axes',
      price: '10.00',
      fitment: { make: ['Test Make'], model: models, year: years, engine: engines },
    });
    expect(row?.fitments.length).toBeLessThanOrEqual(250);
    expect(row?.fitments.length).toBeGreaterThan(0);
  });
});
