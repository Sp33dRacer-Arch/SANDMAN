export type SearchableProduct = {
  name: string;
  sku: string;
  manufacturerPn?: string | null;
  brand?: string | null;
  category?: { name?: string | null } | null;
};

function norm(value: unknown) {
  return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function compact(value: unknown) {
  return norm(value).replace(/\s+/g, '');
}

export function scoreProductSearch(product: SearchableProduct, query: string) {
  const q = norm(query);
  const qc = compact(query);
  if (!q) return 0;
  const fields = {
    sku: norm(product.sku),
    mpn: norm(product.manufacturerPn),
    name: norm(product.name),
    brand: norm(product.brand),
    category: norm(product.category?.name),
  };
  const compactFields = { sku: compact(product.sku), mpn: compact(product.manufacturerPn) };
  let score = 0;
  if (qc && compactFields.sku === qc) score = Math.max(score, 1000);
  if (qc && compactFields.mpn === qc) score = Math.max(score, 980);
  if (fields.name === q) score = Math.max(score, 930);
  if (fields.name.startsWith(q)) score = Math.max(score, 850);
  if (fields.brand === q) score = Math.max(score, 760);
  if (fields.sku.includes(q) || fields.mpn.includes(q)) score = Math.max(score, 720);
  if (fields.name.includes(q)) score = Math.max(score, 650);
  if (fields.category.includes(q)) score = Math.max(score, 420);
  const tokens = q.split(/\s+/).filter(Boolean);
  if (tokens.length > 1) {
    const haystack = `${fields.name} ${fields.brand} ${fields.category} ${fields.sku} ${fields.mpn}`;
    const hits = tokens.filter(token => haystack.includes(token)).length;
    score += Math.round((hits / tokens.length) * 120);
  }
  return score;
}
