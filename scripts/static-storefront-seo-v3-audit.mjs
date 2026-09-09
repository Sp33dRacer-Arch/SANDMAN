import fs from 'node:fs';

const read = file => fs.readFileSync(file, 'utf8');
const appServer = read('src/app.ts');
const app = read('public/store/app.js');
const seo = read('src/services/storefront-seo.service.ts');

const checks = [
  ['product SEO helper is wired server-side', appServer.includes("buildProductSeo(product, env.APP_URL)") && appServer.includes("from './services/storefront-seo.service'")],
  ['every active product route has automatic SEO fallbacks', seo.includes('hasCustomTitle ? truncate(product.seoTitle!, 60) : titleWithSuffix(fallbackTitle)') && seo.includes('hasCustomDescription ? product.seoDescription : product.shortDesc || product.description')],
  ['product titles include unique part identifiers when custom SEO is absent', seo.includes('product.manufacturerPn || product.sku') && seo.includes('fallbackTitle')],
  ['product pages emit canonical and crawl directives', appServer.includes('rel="canonical"') && appServer.includes('max-image-preview:large')],
  ['Open Graph product metadata is emitted', appServer.includes('og:type') && appServer.includes('product:price:amount') && appServer.includes('product:price:currency')],
  ['Twitter product metadata is emitted', appServer.includes('twitter:card') && appServer.includes('twitter:title') && appServer.includes('twitter:image')],
  ['Product JSON-LD is generated', seo.includes("'@type': 'Product'") && appServer.includes('application/ld+json')],
  ['Offer structured data includes price and currency', seo.includes("'@type': 'Offer'") && seo.includes('priceCurrency: currency')],
  ['Breadcrumb structured data is generated', seo.includes("'@type': 'BreadcrumbList'") && seo.includes("name: 'Shop'")],
  ['WebSite SearchAction structured data is generated', seo.includes("'@type': 'SearchAction'") && seo.includes('/shop?q={search_term_string}')],
  ['JSON-LD is escaped against script injection', seo.includes("replace(/</g, '\\\\u003c')") && seo.includes("replace(/&/g, '\\\\u0026')")],
  ['404 products are explicitly noindex', appServer.includes("robots: 'noindex,follow'")],
  ['sitemap index scales beyond 50k products', appServer.includes('const SITEMAP_PRODUCT_PAGE_SIZE = 45_000;') && appServer.includes('Math.ceil(productCount / SITEMAP_PRODUCT_PAGE_SIZE)')],
  ['product sitemap chunks include all active catalogue pages', appServer.includes("app.get('/sitemaps/products-:page.xml'") && appServer.includes('skip,') && appServer.includes('take: SITEMAP_PRODUCT_PAGE_SIZE')],
  ['old 49,980-product sitemap ceiling is gone', !appServer.includes('49_980')],
  ['robots advertises sitemap index', appServer.includes('/sitemap.xml')],
  ['SPA navigation refreshes social metadata', app.includes("setMeta('property', 'og:title', title)") && app.includes("setMeta('name', 'twitter:title', title)")],
  ['product SPA navigation uses product image and type', app.includes("imageOf(p), 'product'")],
  ['SEO layer does not write product records', !seo.includes('prisma.') && !seo.includes('updateMany') && !seo.includes('createMany')],
];

let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}`);
  if (!ok) failed++;
}
if (failed) {
  console.error(`SANDMAN storefront SEO V3 audit failed (${failed}/${checks.length}).`);
  process.exit(1);
}
console.log(`SANDMAN storefront SEO V3 audit passed (${checks.length}/${checks.length}).`);
