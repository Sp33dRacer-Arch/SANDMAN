import { describe, expect, it } from 'vitest';
import { calculateVinyasaRetailPrice, normalizeVinyasaProduct } from '../src/services/vinyasa-normalizer';

const policy = {
  defaultMarkupPercent: 40,
  minMarkupPercent: 10,
  maxMarkupPercent: 800,
  useSupplierRetail: true,
  priceRounding: 'ENDING_99' as const,
};

describe('Vinyasa retail pricing', () => {
  it('uses supplier retail when it stays inside markup guardrails', () => {
    const result = calculateVinyasaRetailPrice({ costCents: 10000, shippingCents: 0, suggestedRetailCents: 14999, policy });
    expect(result.priceCents).toBe(14999);
    expect(result.source).toBe('SUPPLIER_RETAIL');
    expect(result.grossProfitCents).toBe(4999);
  });

  it('clamps product markup overrides to the configured 800% maximum', () => {
    const result = calculateVinyasaRetailPrice({ costCents: 10000, markupOverridePercent: 999, policy });
    expect(result.priceCents).toBeLessThanOrEqual(90000);
    expect(result.markupPercent).toBeLessThanOrEqual(800);
  });

  it('never auto-prices below the 10% minimum markup', () => {
    const result = calculateVinyasaRetailPrice({ costCents: 10000, suggestedRetailCents: 10001, policy });
    expect(result.priceCents).toBeGreaterThanOrEqual(11000);
  });


  it('uses adaptive cost tiers when supplier retail and overrides are absent', () => {
    const result = calculateVinyasaRetailPrice({
      costCents: 2000,
      policy: { ...policy, useSupplierRetail: false, adaptivePricingEnabled: true, lowCostThresholdCents: 2500, lowCostMarkupPercent: 80, midCostThresholdCents: 10000, midCostMarkupPercent: 50, highCostMarkupPercent: 30 },
    });
    expect(result.source).toBe('ADAPTIVE_COST_TIER');
    expect(result.priceCents).toBeGreaterThanOrEqual(3600);
    expect(result.priceCents).toBeLessThanOrEqual(3699);
    expect(result.markupPercent).toBeLessThanOrEqual(800);
  });

  it('lets an explicit pricing rule override supplier RRP', () => {
    const result = calculateVinyasaRetailPrice({
      costCents: 10000,
      suggestedRetailCents: 14999,
      pricingRuleMarkupPercent: 100,
      policy,
    });
    expect(result.source).toBe('PRICING_RULE');
    expect(result.priceCents).toBeGreaterThanOrEqual(19999);
  });

  it('normalizes common dealer-feed fields', () => {
    const row = normalizeVinyasaProduct({
      product_id: 'abc',
      sku: 'VIN-123',
      title: 'Turbo inlet',
      description: 'A test turbo inlet',
      dealer_price: 75.5,
      recommended_retail_price: 129.99,
      inventory: 8,
      currency: 'USD',
      images: [{ url: 'https://example.com/a.jpg' }],
      category: { name: 'Intake' },
      specifications: { material: 'Aluminium', diameter: '76 mm' },
      video_url: 'https://example.com/demo.mp4',
    });
    expect(row?.supplierProductId).toBe('abc');
    expect(row?.costCents).toBe(7550);
    expect(row?.suggestedRetailCents).toBe(12999);
    expect(row?.stock).toBe(8);
    expect(row?.images).toHaveLength(1);
    expect(row?.specs?.material).toBe('Aluminium');
    expect(row?.videoUrl).toBe('https://example.com/demo.mp4');
  });

  it('normalizes nested pricing, inventory, shipping and media fields', () => {
    const row = normalizeVinyasaProduct({
      product: { id: 'nested-1', sku: 'NEST-1', name: 'Nested turbo kit', description: 'Nested feed example' },
      pricing: { dealer_price: 500, msrp: 799 },
      inventory: { available_stock: 4 },
      shipping: { cost: 25, lead_time_days: 3, country: 'US' },
      media: { images: ['https://example.com/nested.jpg'] },
    });
    expect(row?.costCents).toBe(50000);
    expect(row?.suggestedRetailCents).toBe(79900);
    expect(row?.shippingCents).toBe(2500);
    expect(row?.stock).toBe(4);
    expect(row?.warehouseCountry).toBe('US');
    expect(row?.images).toHaveLength(1);
  });

});
