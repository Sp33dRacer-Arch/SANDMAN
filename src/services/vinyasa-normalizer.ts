export type VinyasaNormalizedProduct = {
  supplierProductId: string;
  supplierSku: string;
  name: string;
  description: string;
  shortDesc?: string;
  brand?: string;
  manufacturerPn?: string;
  categoryName: string;
  categorySlug: string;
  costCents: number;
  suggestedRetailCents?: number;
  shippingCents: number;
  currency: string;
  stock: number;
  stockKnown: boolean;
  leadTimeDays?: number;
  warehouseCountry?: string;
  weightGrams?: number;
  lengthMm?: number;
  widthMm?: number;
  heightMm?: number;
  isUniversal: boolean;
  requiresFitment: boolean;
  taxable: boolean;
  hsCode?: string;
  countryOfOrigin?: string;
  customsDescription?: string;
  warrantyText?: string;
  returnDays?: number;
  specs?: Record<string, unknown>;
  videoUrl?: string;
  images: string[];
  fitments: Array<{ vehicleVariantId?: string; make?: string; model?: string; engineCode?: string; engineName?: string; yearStart?: number; yearEnd?: number; applicationText?: string }>;
  raw: Record<string, unknown>;
};

export type VinyasaPricingPolicy = {
  defaultMarkupPercent: number;
  minMarkupPercent: number;
  maxMarkupPercent: number;
  adaptivePricingEnabled?: boolean;
  lowCostThresholdCents?: number;
  lowCostMarkupPercent?: number;
  midCostThresholdCents?: number;
  midCostMarkupPercent?: number;
  highCostMarkupPercent?: number;
  useSupplierRetail: boolean;
  priceRounding: 'NONE' | 'ENDING_99' | 'ENDING_95' | 'NEAREST_100';
};

export type VinyasaPriceDecision = {
  priceCents: number;
  landedCents: number;
  grossProfitCents: number;
  markupPercent: number;
  marginPercent: number;
  source: 'RETAIL_OVERRIDE' | 'MARKUP_OVERRIDE' | 'SUPPLIER_RETAIL' | 'PRICING_RULE' | 'ADAPTIVE_COST_TIER' | 'DEFAULT_MARKUP';
};

const asRecord = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown>
  : undefined;

const pick = (record: Record<string, unknown>, keys: string[]) => {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null && record[key] !== '') return record[key];
  }
  return undefined;
};

const asString = (value: unknown) => typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();

const asNumber = (value: unknown) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const normalized = value.replace(/[^0-9.+-]/g, '');
    const parsed = Number(normalized);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
};

const centsFromMoney = (value: unknown, unit: 'MAJOR' | 'MINOR') => {
  const amount = asNumber(value);
  if (amount === undefined) return undefined;
  return unit === 'MINOR' ? Math.max(0, Math.round(amount)) : Math.max(0, Math.round(amount * 100));
};

const intFrom = (value: unknown) => {
  const n = asNumber(value);
  return n === undefined ? undefined : Math.max(0, Math.round(n));
};

const boolFrom = (value: unknown, fallback: boolean) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const s = value.trim().toLowerCase();
    if (['true', 'yes', '1', 'y'].includes(s)) return true;
    if (['false', 'no', '0', 'n'].includes(s)) return false;
  }
  return fallback;
};

export function slugifyVinyasa(value: string) {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || 'vinyasa';
}

function normalizeCurrency(value: unknown) {
  const currency = asString(value).toUpperCase();
  return /^[A-Z]{3}$/.test(currency) ? currency : 'USD';
}

function normalizeCountry(value: unknown) {
  const country = asString(value).toUpperCase();
  return /^[A-Z]{2}$/.test(country) ? country : undefined;
}


function normalizeSpecs(value: unknown): Record<string, unknown> | undefined {
  const record = asRecord(value);
  if (record) {
    const out: Record<string, unknown> = {};
    for (const [key, rawValue] of Object.entries(record).slice(0, 100)) {
      if (rawValue == null || ['string', 'number', 'boolean'].includes(typeof rawValue)) out[key] = rawValue;
      else if (Array.isArray(rawValue)) out[key] = rawValue.slice(0, 25).map(v => (v == null || ['string', 'number', 'boolean'].includes(typeof v)) ? v : String(v));
      else {
        const nested = asRecord(rawValue);
        if (nested) out[key] = Object.fromEntries(Object.entries(nested).slice(0, 20).filter(([, v]) => v == null || ['string', 'number', 'boolean'].includes(typeof v)));
      }
    }
    return Object.keys(out).length ? out : undefined;
  }
  if (Array.isArray(value)) {
    const out: Record<string, unknown> = {};
    for (const entry of value.slice(0, 100)) {
      const item = asRecord(entry);
      if (!item) continue;
      const key = asString(pick(item, ['name', 'label', 'key', 'attribute']));
      const rawValue = pick(item, ['value', 'text', 'displayValue', 'display_value']);
      if (key && rawValue != null) out[key] = ['string', 'number', 'boolean'].includes(typeof rawValue) ? rawValue : String(rawValue);
    }
    return Object.keys(out).length ? out : undefined;
  }
  return undefined;
}

function flattenImageUrls(value: unknown): string[] {
  const out: string[] = [];
  const visit = (entry: unknown) => {
    if (typeof entry === 'string') {
      const trimmed = entry.trim();
      if (/^https:\/\//i.test(trimmed)) out.push(trimmed);
      return;
    }
    if (Array.isArray(entry)) {
      entry.forEach(visit);
      return;
    }
    const record = asRecord(entry);
    if (!record) return;
    visit(pick(record, ['url', 'src', 'image', 'imageUrl', 'image_url', 'large', 'original']));
  };
  visit(value);
  return [...new Set(out)].slice(0, 12);
}

function scalarList(value: unknown): string[] {
  const source = Array.isArray(value) ? value : value == null || value === '' ? [] : [value];
  return [...new Set(source.map(asString).filter(Boolean))].slice(0, 80);
}

function yearBoundsFrom(value: unknown): { yearStart?: number; yearEnd?: number } {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1886 && value <= 2200) return { yearStart: value, yearEnd: value };
  const text = asString(value);
  const range = text.match(/\b((?:19|20)\d{2})\s*(?:-|–|—|to)\s*((?:19|20)\d{2})\b/i);
  if (range) {
    const first = Number(range[1]);
    const second = Number(range[2]);
    return { yearStart: Math.min(first, second), yearEnd: Math.max(first, second) };
  }
  const single = text.match(/\b((?:19|20)\d{2})\b/);
  if (single) {
    const year = Number(single[1]);
    return { yearStart: year, yearEnd: year };
  }
  return {};
}

function normalizeFitments(value: unknown, applicationsValue?: unknown) {
  type Row = VinyasaNormalizedProduct['fitments'][number];
  const out: Row[] = [];
  const push = (row: Row | null | undefined) => {
    if (!row || out.length >= 250) return;
    const useful = row.vehicleVariantId || row.engineCode || row.engineName || (row.make && row.model) || row.applicationText;
    if (!useful) return;
    out.push(row);
  };
  const fromRecord = (record: Record<string, unknown>) => {
    const vehicleVariantId = asString(pick(record, ['vehicleVariantId', 'vehicle_variant_id'])) || undefined;
    const make = asString(pick(record, ['make', 'vehicleMake', 'vehicle_make'])) || undefined;
    const model = asString(pick(record, ['model', 'vehicleModel', 'vehicle_model'])) || undefined;
    const engineCode = asString(pick(record, ['engineCode', 'engine_code'])) || undefined;
    const engineName = asString(pick(record, ['engineName', 'engine_name', 'engine'])) || undefined;
    const explicitStart = intFrom(pick(record, ['yearStart', 'year_start', 'fromYear', 'from_year']));
    const explicitEnd = intFrom(pick(record, ['yearEnd', 'year_end', 'toYear', 'to_year']));
    const year = yearBoundsFrom(pick(record, ['year', 'years', 'modelYear', 'model_year']));
    push({ vehicleVariantId, make, model, engineCode, engineName, yearStart: explicitStart ?? year.yearStart, yearEnd: explicitEnd ?? year.yearEnd });
  };
  const fromAxisObject = (record: Record<string, unknown>) => {
    const vehicleVariantId = asString(pick(record, ['vehicleVariantId', 'vehicle_variant_id'])) || undefined;
    if (vehicleVariantId) { fromRecord(record); return; }
    const makes = scalarList(pick(record, ['make', 'makes', 'vehicleMake', 'vehicle_make']));
    const models = scalarList(pick(record, ['model', 'models', 'vehicleModel', 'vehicle_model']));
    const engineCodes = scalarList(pick(record, ['engineCode', 'engine_code']));
    const engineNames = scalarList(pick(record, ['engine', 'engines', 'engineName', 'engine_name']));
    const yearValues = scalarList(pick(record, ['year', 'years', 'modelYear', 'model_year']));
    const explicitStart = intFrom(pick(record, ['yearStart', 'year_start', 'fromYear', 'from_year']));
    const explicitEnd = intFrom(pick(record, ['yearEnd', 'year_end', 'toYear', 'to_year']));
    const years = yearValues.length ? yearValues.map(yearBoundsFrom) : [{ yearStart: explicitStart, yearEnd: explicitEnd }];
    let pairs: Array<{ make?: string; model?: string }> = [];
    if (makes.length && models.length) {
      if (makes.length === 1) pairs = models.map(model => ({ make: makes[0], model }));
      else if (models.length === 1) pairs = makes.map(make => ({ make, model: models[0] }));
      else if (makes.length === models.length) pairs = makes.map((make, index) => ({ make, model: models[index] }));
      else if (makes.length * models.length <= 16) pairs = makes.flatMap(make => models.map(model => ({ make, model })));
    } else if (makes.length || models.length) {
      pairs = (makes.length ? makes : models).map(value => makes.length ? { make: value } : { model: value });
    } else {
      pairs = [{}];
    }
    const engines: Array<{ engineCode?: string; engineName?: string }> = engineCodes.length
      ? engineCodes.map(engineCode => ({ engineCode }))
      : engineNames.length ? engineNames.map(engineName => ({ engineName })) : [{}];
    fitmentExpansion:
    for (const pair of pairs) {
      for (const year of years) {
        for (const engine of engines) {
          push({ ...pair, ...engine, ...year });
          if (out.length >= 250) break fitmentExpansion;
        }
      }
    }
  };

  if (Array.isArray(value)) {
    for (const entry of value.slice(0, 250)) {
      if (typeof entry === 'string') push({ applicationText: entry.trim() || undefined, ...yearBoundsFrom(entry) });
      else { const record = asRecord(entry); if (record) fromAxisObject(record); }
      if (out.length >= 250) break;
    }
  } else {
    const record = asRecord(value);
    if (record) fromAxisObject(record);
  }
  if (Array.isArray(applicationsValue)) {
    for (const entry of applicationsValue.slice(0, 80)) {
      if (typeof entry === 'string') push({ applicationText: entry.trim() || undefined, ...yearBoundsFrom(entry) });
      else { const record = asRecord(entry); if (record) fromRecord(record); }
      if (out.length >= 250) break;
    }
  }
  const deduped = new Map<string, Row>();
  for (const row of out) {
    const key = JSON.stringify([row.vehicleVariantId, row.make, row.model, row.engineCode, row.engineName, row.yearStart, row.yearEnd, row.applicationText]);
    if (!deduped.has(key)) deduped.set(key, row);
  }
  return [...deduped.values()].slice(0, 250);
}

export function extractVinyasaItems(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  const record = asRecord(payload);
  if (!record) return [];
  for (const key of ['products', 'items', 'results', 'catalog', 'data']) {
    const value = record[key];
    if (Array.isArray(value)) return value;
    const nested = asRecord(value);
    if (nested) {
      for (const nestedKey of ['products', 'items', 'results', 'data']) {
        if (Array.isArray(nested[nestedKey])) return nested[nestedKey] as unknown[];
      }
    }
  }
  return [];
}

export function hasVinyasaCatalogCollection(payload: unknown) {
  if (Array.isArray(payload)) return true;
  const record = asRecord(payload);
  if (!record) return false;
  for (const key of ['products', 'items', 'results', 'catalog', 'data']) {
    const value = record[key];
    if (Array.isArray(value)) return true;
    const nested = asRecord(value);
    if (nested && ['products', 'items', 'results', 'data'].some(nestedKey => Array.isArray(nested[nestedKey]))) return true;
  }
  return false;
}

export function extractVinyasaNext(payload: unknown): { nextCursor?: string; nextPage?: number; hasMore?: boolean } {
  const record = asRecord(payload);
  if (!record) return {};
  const meta = asRecord(record.meta) ?? asRecord(record.pagination) ?? asRecord(record.data) ?? record;
  const nextCursor = asString(pick(meta, ['nextCursor', 'next_cursor', 'cursor', 'next'])) || undefined;
  const nextPage = intFrom(pick(meta, ['nextPage', 'next_page']));
  const hasMoreValue = pick(meta, ['hasMore', 'has_more', 'more']);
  let hasMore = hasMoreValue === undefined ? undefined : boolFrom(hasMoreValue, false);
  let resolvedCursor = nextCursor;
  let resolvedPage = nextPage;
  const links = asRecord(record.links) ?? asRecord(meta.links);
  const nextLink = links ? asString(pick(links, ['next', 'nextUrl', 'next_url'])) : '';
  if (nextLink) {
    try {
      const url = new URL(nextLink, 'https://vinyasa.invalid');
      resolvedCursor = resolvedCursor || url.searchParams.get('after') || url.searchParams.get('cursor') || url.searchParams.get('page_cursor') || undefined;
      resolvedPage = resolvedPage ?? intFrom(url.searchParams.get('page'));
      hasMore = true;
    } catch { /* Ignore malformed pagination links; page fallback still works. */ }
  }
  const currentPage = intFrom(pick(meta, ['currentPage', 'current_page', 'page']));
  const lastPage = intFrom(pick(meta, ['lastPage', 'last_page', 'totalPages', 'total_pages']));
  if (resolvedPage == null && currentPage != null && lastPage != null && currentPage < lastPage) resolvedPage = currentPage + 1;
  if (hasMore === undefined && currentPage != null && lastPage != null) hasMore = currentPage < lastPage;
  return { nextCursor: resolvedCursor, nextPage: resolvedPage, hasMore };
}

export function normalizeVinyasaProduct(input: unknown, moneyUnit: 'MAJOR' | 'MINOR' = 'MAJOR'): VinyasaNormalizedProduct | null {
  const outer = asRecord(input);
  if (!outer) return null;
  const nestedProduct = asRecord(pick(outer, ['product', 'item']));
  const raw = nestedProduct ? { ...outer, ...nestedProduct } : outer;
  const pricing = asRecord(pick(raw, ['pricing', 'prices', 'priceData', 'price_data']));
  const inventoryValue = pick(raw, ['inventory', 'availability', 'stockInfo', 'stock_info']);
  const inventoryRecord = asRecord(inventoryValue);
  const shippingRecord = asRecord(pick(raw, ['shipping', 'fulfillment', 'delivery']));
  const mediaRecord = asRecord(pick(raw, ['media', 'assets']));

  const supplierProductId = asString(pick(raw, ['id', 'productId', 'product_id', 'uuid', 'itemId', 'item_id']));
  const supplierSku = asString(pick(raw, ['sku', 'partNumber', 'part_number', 'manufacturerPartNumber', 'manufacturer_part_number', 'mpn']));
  const name = asString(pick(raw, ['name', 'title', 'productName', 'product_name']));
  const description = asString(pick(raw, ['description', 'fullDescription', 'full_description', 'details', 'body'])) || name;
  if (!supplierProductId || !supplierSku || !name) return null;

  const categoryRaw = pick(raw, ['category', 'categoryName', 'category_name', 'productType', 'product_type']);
  const categoryRecord = asRecord(categoryRaw);
  const categoryName = asString(categoryRecord ? pick(categoryRecord, ['name', 'title']) : categoryRaw) || 'Vinyasa Parts';

  const costCents = centsFromMoney(pick(raw, ['dealerPrice', 'dealer_price', 'wholesalePrice', 'wholesale_price', 'cost', 'price', 'dealerCost', 'dealer_cost'])
    ?? (pricing ? pick(pricing, ['dealerPrice', 'dealer_price', 'wholesalePrice', 'wholesale_price', 'cost', 'dealerCost', 'dealer_cost', 'price']) : undefined), moneyUnit);
  if (costCents === undefined) return null;

  const suggestedRetailCents = centsFromMoney(pick(raw, ['recommendedRetailPrice', 'recommended_retail_price', 'retailPrice', 'retail_price', 'msrp', 'rrp', 'listPrice', 'list_price', 'mapPrice', 'map_price'])
    ?? (pricing ? pick(pricing, ['recommendedRetailPrice', 'recommended_retail_price', 'retailPrice', 'retail_price', 'msrp', 'rrp', 'listPrice', 'list_price', 'mapPrice', 'map_price']) : undefined), moneyUnit);
  const shippingCents = centsFromMoney(pick(raw, ['shippingPrice', 'shipping_price', 'shippingCost', 'shipping_cost'])
    ?? (shippingRecord ? pick(shippingRecord, ['price', 'cost', 'shippingPrice', 'shipping_price', 'shippingCost', 'shipping_cost']) : undefined), moneyUnit) ?? 0;
  const stockRaw = pick(raw, [
  'stock',
  'quantity',
  'qty',
  'availableQty',
  'available_qty',
  'stockQuantity',
  'stock_quantity',
])
  ?? (inventoryRecord
    ? pick(inventoryRecord, [
        'stock',
        'quantity',
        'qty',
        'available',
        'availableQty',
        'available_qty',
        'availableStock',
        'available_stock',
      ])
    : inventoryValue);

const parsedStock = intFrom(stockRaw);

const inStockRaw = pick(raw, ['inStock', 'in_stock']);
const explicitlyOutOfStock = inStockRaw === false;

const stockKnown = parsedStock !== undefined || explicitlyOutOfStock;
const stock = parsedStock ?? 0;
  const images = flattenImageUrls(pick(raw, ['images', 'imageUrls', 'image_urls', 'gallery', 'image', 'imageUrl', 'image_url'])
    ?? (mediaRecord ? pick(mediaRecord, ['images', 'gallery', 'assets']) : undefined));
  const isUniversal = boolFrom(pick(raw, ['isUniversal', 'is_universal', 'universal']), false);
  const requiresFitment = boolFrom(pick(raw, ['requiresFitment', 'requires_fitment']), !isUniversal);

  const dimensions = asRecord(pick(raw, ['dimensions', 'packageDimensions', 'package_dimensions']));
  const weightValue = pick(raw, ['weightGrams', 'weight_grams']) ?? (dimensions ? pick(dimensions, ['weightGrams', 'weight_grams']) : undefined);
  let weightGrams = intFrom(weightValue);
  if (weightGrams === undefined) {
    const pounds = asNumber(pick(raw, ['weight', 'weightLb', 'weight_lb', 'weightLbs', 'weight_lbs']));
    if (pounds !== undefined) weightGrams = Math.round(pounds * 453.59237);
  }

  const lengthMm = intFrom(pick(raw, ['lengthMm', 'length_mm']) ?? (dimensions ? pick(dimensions, ['lengthMm', 'length_mm']) : undefined));
  const widthMm = intFrom(pick(raw, ['widthMm', 'width_mm']) ?? (dimensions ? pick(dimensions, ['widthMm', 'width_mm']) : undefined));
  const heightMm = intFrom(pick(raw, ['heightMm', 'height_mm']) ?? (dimensions ? pick(dimensions, ['heightMm', 'height_mm']) : undefined));

  return {
    supplierProductId,
    supplierSku,
    name,
    description,
    shortDesc: asString(pick(raw, ['shortDescription', 'short_description', 'summary'])) || undefined,
    brand: asString(pick(raw, ['brand', 'manufacturer', 'make'])) || undefined,
    manufacturerPn: asString(pick(raw, ['manufacturerPartNumber', 'manufacturer_part_number', 'mpn', 'partNumber', 'part_number'])) || supplierSku,
    categoryName,
    categorySlug: slugifyVinyasa(categoryName),
    costCents,
    suggestedRetailCents,
    shippingCents,
    currency: normalizeCurrency(pick(raw, ['currency', 'currencyCode', 'currency_code'])),
    stock,
    stockKnown,
    leadTimeDays: intFrom(pick(raw, ['leadTimeDays', 'lead_time_days', 'leadTime', 'lead_time']) ?? (shippingRecord ? pick(shippingRecord, ['leadTimeDays', 'lead_time_days', 'leadTime', 'lead_time', 'days']) : undefined)),
    warehouseCountry: normalizeCountry(pick(raw, ['warehouseCountry', 'warehouse_country', 'shipFromCountry', 'ship_from_country']) ?? (shippingRecord ? pick(shippingRecord, ['warehouseCountry', 'warehouse_country', 'shipFromCountry', 'ship_from_country', 'country']) : undefined)),
    weightGrams,
    lengthMm,
    widthMm,
    heightMm,
    isUniversal,
    requiresFitment,
    taxable: boolFrom(pick(raw, ['taxable']), true),
    hsCode: asString(pick(raw, ['hsCode', 'hs_code', 'harmonizedCode', 'harmonized_code'])) || undefined,
    countryOfOrigin: normalizeCountry(pick(raw, ['countryOfOrigin', 'country_of_origin', 'originCountry', 'origin_country'])),
    customsDescription: asString(pick(raw, ['customsDescription', 'customs_description'])) || undefined,
    warrantyText: asString(pick(raw, ['warranty', 'warrantyText', 'warranty_text'])) || undefined,
    returnDays: intFrom(pick(raw, ['returnDays', 'return_days'])),
    specs: normalizeSpecs(pick(raw, ['specifications', 'specs', 'attributes', 'features', 'technicalData', 'technical_data'])),
    videoUrl: (() => { const value = asString(pick(raw, ['videoUrl', 'video_url', 'video'])); return /^https:\/\//i.test(value) ? value : undefined; })(),
    images,
    fitments: normalizeFitments(pick(raw, ['fitment', 'fitments', 'vehicles', 'compatibility']), pick(raw, ['applications'])),
    raw: outer,
  };
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function roundRetail(priceCents: number, mode: VinyasaPricingPolicy['priceRounding']) {
  if (mode === 'NONE') return Math.max(1, Math.round(priceCents));
  if (mode === 'NEAREST_100') return Math.max(100, Math.round(priceCents / 100) * 100);
  const ending = mode === 'ENDING_95' ? 95 : 99;
  const whole = Math.floor(priceCents / 100);
  const candidate = whole * 100 + ending;
  return candidate >= priceCents ? candidate : (whole + 1) * 100 + ending;
}

export function calculateVinyasaRetailPrice(input: {
  costCents: number;
  shippingCents?: number;
  suggestedRetailCents?: number | null;
  markupOverridePercent?: number | null;
  retailOverrideCents?: number | null;
  pricingRuleMarkupPercent?: number | null;
  pricingRuleFixedMarkupCents?: number | null;
  pricingRuleMinimumProfitCents?: number | null;
  policy: VinyasaPricingPolicy;
}): VinyasaPriceDecision {
  const landedCents = Math.max(0, Math.round(input.costCents + (input.shippingCents ?? 0)));
  const minMarkupPercent = clamp(input.policy.minMarkupPercent, 10, 800);
  const maxMarkupPercent = clamp(Math.max(input.policy.maxMarkupPercent, minMarkupPercent), minMarkupPercent, 800);
  const defaultMarkupPercent = clamp(input.policy.defaultMarkupPercent, minMarkupPercent, maxMarkupPercent);
  const minPrice = landedCents + Math.round(landedCents * minMarkupPercent / 100);
  const maxPrice = landedCents + Math.round(landedCents * maxMarkupPercent / 100);

  let rawPrice = minPrice;
  let source: VinyasaPriceDecision['source'] = 'DEFAULT_MARKUP';

  if (input.retailOverrideCents != null && input.retailOverrideCents > 0) {
    rawPrice = clamp(Math.round(input.retailOverrideCents), minPrice, maxPrice);
    source = 'RETAIL_OVERRIDE';
  } else if (input.markupOverridePercent != null) {
    const percent = clamp(input.markupOverridePercent, minMarkupPercent, maxMarkupPercent);
    rawPrice = landedCents + Math.round(landedCents * percent / 100);
    source = 'MARKUP_OVERRIDE';
  } else if (input.pricingRuleMarkupPercent != null || input.pricingRuleFixedMarkupCents != null || input.pricingRuleMinimumProfitCents != null) {
    const ruleMarkup = input.pricingRuleMarkupPercent == null ? 0 : clamp(input.pricingRuleMarkupPercent, minMarkupPercent, maxMarkupPercent);
    const percentProfit = Math.round(landedCents * ruleMarkup / 100);
    const ruleProfit = Math.max(percentProfit + (input.pricingRuleFixedMarkupCents ?? 0), input.pricingRuleMinimumProfitCents ?? 0);
    rawPrice = landedCents + ruleProfit;
    rawPrice = clamp(rawPrice, minPrice, maxPrice);
    source = 'PRICING_RULE';
  } else if (input.policy.useSupplierRetail && input.suggestedRetailCents != null && input.suggestedRetailCents > landedCents) {
    const supplierRetail = Math.round(input.suggestedRetailCents);
    if (supplierRetail >= minPrice && supplierRetail <= maxPrice) {
      rawPrice = supplierRetail;
      source = 'SUPPLIER_RETAIL';
    } else {
      rawPrice = landedCents + Math.round(landedCents * defaultMarkupPercent / 100);
    }
  } else if (input.policy.adaptivePricingEnabled) {
    const lowThreshold = Math.max(1, Math.round(input.policy.lowCostThresholdCents ?? 2500));
    const midThreshold = Math.max(lowThreshold, Math.round(input.policy.midCostThresholdCents ?? 10000));
    const tierMarkup = landedCents <= lowThreshold
      ? (input.policy.lowCostMarkupPercent ?? 80)
      : landedCents <= midThreshold
        ? (input.policy.midCostMarkupPercent ?? 50)
        : (input.policy.highCostMarkupPercent ?? 30);
    const percent = clamp(tierMarkup, minMarkupPercent, maxMarkupPercent);
    rawPrice = landedCents + Math.round(landedCents * percent / 100);
    source = 'ADAPTIVE_COST_TIER';
  } else {
    rawPrice = landedCents + Math.round(landedCents * defaultMarkupPercent / 100);
  }

  let priceCents = roundRetail(rawPrice, input.policy.priceRounding);
  priceCents = clamp(priceCents, minPrice, maxPrice);
  const grossProfitCents = Math.max(0, priceCents - landedCents);
  const markupPercent = landedCents > 0 ? (grossProfitCents / landedCents) * 100 : 0;
  const marginPercent = priceCents > 0 ? (grossProfitCents / priceCents) * 100 : 0;
  return {
    priceCents,
    landedCents,
    grossProfitCents,
    markupPercent: Math.round(markupPercent * 100) / 100,
    marginPercent: Math.round(marginPercent * 100) / 100,
    source,
  };
}
