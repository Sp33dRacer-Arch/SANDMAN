import { describe, expect, it } from 'vitest';
import { scoreProductSearch } from '../src/services/search-ranking.service';

describe('search ranking', () => {
  const product = { name: 'B58 Performance Charge Pipe', sku: 'SM-B58-CP-001', manufacturerPn: 'B58CP01', brand: 'SANDMAN', category: { name: 'Intake & Boost' } };
  it('ranks exact SKU above broad name matches', () => {
    expect(scoreProductSearch(product, 'SM-B58-CP-001')).toBeGreaterThan(scoreProductSearch(product, 'B58'));
  });
  it('normalizes punctuation for part numbers', () => {
    expect(scoreProductSearch(product, 'SMB58CP001')).toBeGreaterThanOrEqual(1000);
  });
});
