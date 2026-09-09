import { describe, expect, it } from 'vitest';
import { buildProductSeo, safeJsonLd } from '../src/services/storefront-seo.service';

const product = {
  slug: 'b58-charge-pipe',
  name: 'B58 Charge Pipe',
  sku: 'SM-B58-CP-001',
  brand: 'SANDMAN Performance',
  manufacturerPn: 'B58-CP-001',
  description: 'High-flow aluminium charge pipe engineered for B58 applications with reinforced couplers and secure fitment.',
  shortDesc: null,
  seoTitle: null,
  seoDescription: null,
  priceCents: 24999,
  currency: 'USD',
  condition: 'NEW',
  sourceType: 'DROPSHIP',
  stockQuantity: 12,
  category: { name: 'Forced Induction', slug: 'forced-induction' },
  images: [{ url: 'https://cdn.example.com/b58.jpg', alt: null }],
  supplierLinks: [],
};

describe('storefront product SEO', () => {
  it('generates unique bounded metadata for products without manual SEO', () => {
    const seo = buildProductSeo(product, 'https://the-sandmans.com/');
    expect(seo.title.length).toBeLessThanOrEqual(60);
    expect(seo.title).toContain('B58-CP-001');
    expect(seo.description.length).toBeLessThanOrEqual(160);
    expect(seo.canonical).toBe('https://the-sandmans.com/products/b58-charge-pipe');
    expect(seo.type).toBe('product');
    expect(seo.availability).toBe('in stock');
  });

  it('emits Product, Offer and Breadcrumb structured data', () => {
    const seo = buildProductSeo(product, 'https://the-sandmans.com');
    const schema = seo.jsonLd as Array<Record<string, any>>;
    expect(schema[0]!['@type']).toBe('Product');
    expect(schema[0]!.offers.price).toBe('249.99');
    expect(schema[0]!.offers.priceCurrency).toBe('USD');
    expect(schema[1]!['@type']).toBe('BreadcrumbList');
  });

  it('honors custom SEO fields while keeping safe length limits', () => {
    const seo = buildProductSeo({ ...product, seoTitle: 'Custom Product SEO Title', seoDescription: 'Custom SEO description for the exact automotive product listing and its fitment information.' }, 'https://the-sandmans.com');
    expect(seo.title).toBe('Custom Product SEO Title');
    expect(seo.description).toContain('Custom SEO description');
  });



  it('ignores legacy Vinyasa generated SEO fields but preserves real custom SEO', () => {
    const legacy = buildProductSeo({
      ...product,
      seoTitle: `${product.name}${product.brand ? ` | ${product.brand}` : ''} â€” SANDMAN`.slice(0, 180),
      seoDescription: String(product.shortDesc || product.description).slice(0, 300),
    }, 'https://the-sandmans.com');
    expect(legacy.title).toContain('B58-CP-001');
    expect(legacy.title).not.toBe(`${product.name} | ${product.brand} â€” SANDMAN`);

    const custom = buildProductSeo({ ...product, seoTitle: 'Human-edited SEO title', seoDescription: 'Human-edited SEO description that should remain authoritative for this exact product listing.' }, 'https://the-sandmans.com');
    expect(custom.title).toBe('Human-edited SEO title');
    expect(custom.description).toContain('Human-edited SEO description');
  });

  it('escapes characters that could terminate JSON-LD script blocks', () => {
    expect(safeJsonLd({ value: '</script><script>' })).not.toContain('</script>');
    expect(safeJsonLd({ value: '</script><script>' })).toContain('\\u003c');
  });
});
