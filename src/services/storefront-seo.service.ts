export type StorefrontSeoProduct = {
  slug: string;
  name: string;
  sku: string;
  brand: string | null;
  manufacturerPn: string | null;
  description: string;
  shortDesc: string | null;
  seoTitle: string | null;
  seoDescription: string | null;
  priceCents: number;
  currency: string;
  condition: string;
  sourceType: string;
  stockQuantity: number | null;
  category: { name: string; slug: string };
  images: Array<{ url: string; alt: string | null }>;
  supplierLinks: Array<{ active: boolean; stock: number | null; availableStock: number | null }>;
};

export type ProductSeoMeta = {
  title: string;
  description: string;
  canonical: string;
  image: string | null;
  imageAlt: string;
  type: 'product';
  robots: string;
  productPrice: string;
  productCurrency: string;
  availability?: 'in stock' | 'out of stock';
  jsonLd: unknown[];
};

const compactText = (value: string | null | undefined) => String(value ?? '')
  .replace(/<[^>]*>/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const truncate = (value: string, max: number) => {
  const clean = compactText(value);
  if (clean.length <= max) return clean;
  const clipped = clean.slice(0, Math.max(1, max - 1));
  const boundary = clipped.lastIndexOf(' ');
  return `${(boundary >= Math.floor(max * 0.65) ? clipped.slice(0, boundary) : clipped).trim()}…`;
};

const titleWithBrand = (name: string, brand: string | null) => {
  const cleanName = compactText(name);
  const cleanBrand = compactText(brand);
  if (!cleanBrand || cleanName.toLowerCase().includes(cleanBrand.toLowerCase())) return cleanName;
  return `${cleanBrand} ${cleanName}`;
};

const titleWithSuffix = (value: string) => {
  const suffix = ' | SANDMAN';
  const clean = compactText(value);
  if (clean.toLowerCase().endsWith('sandman')) return truncate(clean, 60);
  const room = 60 - suffix.length;
  return `${truncate(clean, room)}${suffix}`;
};

const stockState = (product: StorefrontSeoProduct) => {
  if (product.stockQuantity != null) return product.stockQuantity > 0 ? 'in stock' as const : 'out of stock' as const;
  const knownSupplierStocks = product.supplierLinks
    .filter(link => link.active)
    .map(link => link.availableStock ?? link.stock)
    .filter((value): value is number => value != null);
  if (!knownSupplierStocks.length) return undefined;
  return knownSupplierStocks.some(value => value > 0) ? 'in stock' as const : 'out of stock' as const;
};

const schemaAvailability = (availability?: 'in stock' | 'out of stock') => {
  if (availability === 'in stock') return 'https://schema.org/InStock';
  if (availability === 'out of stock') return 'https://schema.org/OutOfStock';
  return undefined;
};

const schemaCondition = (condition: string) => {
  if (condition === 'NEW') return 'https://schema.org/NewCondition';
  if (condition === 'REMANUFACTURED') return 'https://schema.org/RefurbishedCondition';
  return 'https://schema.org/UsedCondition';
};

export function buildProductSeo(product: StorefrontSeoProduct, appUrl: string): ProductSeoMeta {
  const base = appUrl.replace(/\/$/, '');
  const canonical = `${base}/products/${encodeURIComponent(product.slug)}`;
  const partNumber = compactText(product.manufacturerPn || product.sku);
  const brandedName = titleWithBrand(product.name, product.brand);
  const fallbackTitle = `${brandedName}${partNumber ? ` ${partNumber}` : ''}`;
  // Older Vinyasa imports pre-filled seoTitle/seoDescription automatically. Those
  // generated values are not human overrides, so ignore only the exact legacy
  // supplier pattern and preserve every genuinely customized SEO field.
  const legacySupplierTitle = `${product.name}${product.brand ? ` | ${product.brand}` : ''} — SANDMAN`.slice(0, 180);
  const legacySupplierDescription = String(product.shortDesc || product.description || '').slice(0, 300);
  const normalizeLegacySeoText = (value: string | null | undefined) =>
    compactText(String(value ?? '')).replace(/\u00e2\u20ac\u201d/g, '\u2014');

  const hasCustomTitle =
    Boolean(product.seoTitle) &&
    !(product.sourceType === 'DROPSHIP' &&
      normalizeLegacySeoText(product.seoTitle) === normalizeLegacySeoText(legacySupplierTitle));
  const hasCustomDescription =
    Boolean(product.seoDescription) &&
    !(product.sourceType === 'DROPSHIP' &&
      normalizeLegacySeoText(product.seoDescription) === normalizeLegacySeoText(legacySupplierDescription));
  const title = hasCustomTitle ? truncate(product.seoTitle!, 60) : titleWithSuffix(fallbackTitle);

  const sourceDescription = compactText(hasCustomDescription ? product.seoDescription : product.shortDesc || product.description);
  const fallbackDescription = `Shop ${brandedName}${partNumber ? ` (${partNumber})` : ''} from SANDMAN. ${compactText(product.category.name)} automotive part with fitment tools, supplier stock and secure checkout.`;
  const description = truncate(sourceDescription.length >= 70 ? sourceDescription : `${sourceDescription} ${fallbackDescription}`.trim(), 160);

  const image = product.images[0]?.url ?? null;
  const imageAlt = compactText(product.images[0]?.alt) || `${brandedName}${partNumber ? ` ${partNumber}` : ''}`;
  const availability = stockState(product);
  const price = (product.priceCents / 100).toFixed(2);
  const currency = compactText(product.currency || 'USD').toUpperCase();

  const productJsonLd: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    '@id': `${canonical}#product`,
    url: canonical,
    name: compactText(product.name),
    description,
    sku: compactText(product.sku),
    category: compactText(product.category.name),
    itemCondition: schemaCondition(product.condition),
    offers: {
      '@type': 'Offer',
      url: canonical,
      priceCurrency: currency,
      price,
      itemCondition: schemaCondition(product.condition),
      ...(schemaAvailability(availability) ? { availability: schemaAvailability(availability) } : {}),
    },
  };
  if (product.brand) productJsonLd.brand = { '@type': 'Brand', name: compactText(product.brand) };
  if (product.manufacturerPn) productJsonLd.mpn = compactText(product.manufacturerPn);
  if (product.images.length) productJsonLd.image = product.images.map(entry => entry.url).filter(Boolean).slice(0, 8);

  const breadcrumbJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: `${base}/` },
      { '@type': 'ListItem', position: 2, name: 'Shop', item: `${base}/shop` },
      { '@type': 'ListItem', position: 3, name: compactText(product.category.name), item: `${base}/shop?category=${encodeURIComponent(product.category.slug)}` },
      { '@type': 'ListItem', position: 4, name: compactText(product.name), item: canonical },
    ],
  };

  return {
    title,
    description,
    canonical,
    image,
    imageAlt,
    type: 'product',
    robots: 'index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1',
    productPrice: price,
    productCurrency: currency,
    availability,
    jsonLd: [productJsonLd, breadcrumbJsonLd],
  };
}

export function websiteStructuredData(appUrl: string) {
  const base = appUrl.replace(/\/$/, '');
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    '@id': `${base}/#website`,
    url: `${base}/`,
    name: 'SANDMAN',
    potentialAction: {
      '@type': 'SearchAction',
      target: `${base}/shop?q={search_term_string}`,
      'query-input': 'required name=search_term_string',
    },
  };
}

export function safeJsonLd(value: unknown) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}
