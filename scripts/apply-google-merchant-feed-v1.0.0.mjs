#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const SRC = path.join(root, 'src');
const FORCE = process.argv.includes('--force');

function fail(msg) {
  console.error(`FAILED: ${msg}`);
  process.exit(1);
}

function walk(dir) {
  let out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out = out.concat(walk(full));
    else out.push(full);
  }
  return out;
}

function toPosix(p) {
  return p.replace(/\\/g, '/');
}

function relImport(fromFile, targetFile) {
  let rel = toPosix(path.relative(path.dirname(fromFile), targetFile)).replace(/\.tsx?$/, '');
  if (!rel.startsWith('.')) rel = './' + rel;
  return rel;
}

// ---------- 1. Locate the Prisma schema ----------
if (!fs.existsSync(path.join(root, 'package.json'))) {
  fail('No package.json here. Run this from your SANDMAN backend root.');
}
const schemaCandidates = ['prisma/schema.prisma', 'src/prisma/schema.prisma'];
const schemaRel = schemaCandidates.find((p) => fs.existsSync(path.join(root, p)));
if (!schemaRel) fail('Could not find prisma/schema.prisma. Run this from the SANDMAN backend root.');
const schema = fs.readFileSync(path.join(root, schemaRel), 'utf8');

// ---------- 2. Minimal Prisma schema model/field parser ----------
function parseModel(name) {
  const m = schema.match(new RegExp('model\\s+' + name + '\\s*\\{([\\s\\S]*?)\\n\\}'));
  if (!m) return null;
  const fields = [];
  for (const line of m[1].split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('@@') || trimmed.startsWith('//')) continue;
    const fm = trimmed.match(/^(\w+)\s+(\w+)(\[\])?/);
    if (fm) fields.push({ name: fm[1], type: fm[2] + (fm[3] || '') });
  }
  return fields;
}

function pick(fields, ...patterns) {
  for (const re of patterns) {
    const hit = fields.find((f) => re.test(f.name));
    if (hit) return hit.name;
  }
  return null;
}

function modelExists(name) {
  return new RegExp('model\\s+' + name + '\\s*\\{').test(schema);
}

// Names of every model in the schema, so scalar field detection can skip
// relation fields (e.g. a "category" relation field vs. a "categoryId" scalar).
const modelNames = new Set([...schema.matchAll(/model\s+(\w+)\s*\{/g)].map((m) => m[1]));
function scalarOnly(fields) {
  return fields.filter((f) => !modelNames.has(f.type.replace(/\[\]$/, '')));
}

const productFields = parseModel('Product');
if (!productFields) fail('Could not find a "model Product { ... }" in ' + schemaRel + '.');
const productScalars = scalarOnly(productFields);

function pickMoney(fields, ...patterns) {
  const name = pick(fields, ...patterns);
  return name ? { name, cents: /cents$/i.test(name) } : null;
}

const priceField = pickMoney(productScalars, /^priceCents$/i, /^price$/i, /^basePrice(Cents)?$/i, /^unitPrice(Cents)?$/i);
const saleField = pickMoney(
  productScalars,
  /^compareAtCents$/i,
  /^salePrice(Cents)?$/i,
  /^compareAtPrice$/i,
  /^discountPrice(Cents)?$/i
);

const F = {
  title: pick(productScalars, /^title$/i, /^name$/i),
  description: pick(productScalars, /^description$/i),
  slug: pick(productScalars, /^slug$/i, /^handle$/i),
  price: priceField ? priceField.name : null,
  priceCents: Boolean(priceField && priceField.cents),
  salePrice: saleField ? saleField.name : null,
  salePriceCents: Boolean(saleField && saleField.cents),
  currency: pick(productScalars, /^currency$/i),
  stock: pick(productScalars, /^stockQuantity$/i, /^stock$/i, /^quantity$/i, /^availableStock$/i),
  status: pick(productScalars, /^status$/i),
  condition: pick(productScalars, /^condition$/i),
  brand: pick(productScalars, /^brand$/i, /^manufacturer$/i),
  gtin: pick(productScalars, /^gtin$/i, /^upc$/i, /^ean$/i, /^isbn$/i),
  mpn: pick(productScalars, /^mpn$/i, /^manufacturerPn$/i, /^partNumber$/i, /^sku$/i),
  color: pick(productScalars, /^color$/i, /^colour$/i),
  size: pick(productScalars, /^size$/i),
  category: pick(productScalars, /^googleProductCategory$/i, /^category$/i),
  groupId: pick(productScalars, /^groupId$/i, /^familyId$/i, /^parentId$/i),
};
F.imagesRel = (productFields.find((f) => f.type.endsWith('[]') && /image/i.test(f.type)) || {}).name || null;

if (!F.title || !F.description) {
  fail(
    'Product model is missing a recognizable title or description field (both are required by Google). Fields found: ' +
      productFields.map((f) => f.name).join(', ') +
      '. Edit the FIELD MAP section of this script by hand instead of relying on auto-detection.'
  );
}

// ---------- 3. Style/variant detection ----------
const variantModelName = ['ProductVariant', 'ProductStyle', 'Variant', 'Style'].find(modelExists);
let mode;
let variantFields = null;
let relField = null;
let VF = {};

if (variantModelName) {
  variantFields = parseModel(variantModelName);
  const variantScalars = scalarOnly(variantFields);
  relField = pick(variantFields, /^product$/i) || (variantFields.find((f) => f.type === 'Product') || {}).name;
  if (!relField) {
    fail(
      'Found model ' +
        variantModelName +
        ' but could not find its relation field back to Product. Edit the FIELD MAP section by hand.'
    );
  }
  const variantPriceField = pickMoney(variantScalars, /^priceCents$/i, /^price$/i);
  VF = {
    fkId: pick(variantFields, new RegExp('^' + relField + 'Id$', 'i')),
    price: variantPriceField ? variantPriceField.name : null,
    priceCents: Boolean(variantPriceField && variantPriceField.cents),
    stock: pick(variantScalars, /^stockQuantity$/i, /^stock$/i, /^quantity$/i),
    sku: pick(variantScalars, /^sku$/i, /^partNumber$/i),
    gtin: pick(variantScalars, /^gtin$/i, /^upc$/i, /^ean$/i),
    condition: pick(variantScalars, /^condition$/i),
    color: pick(variantScalars, /^color$/i, /^colour$/i),
    size: pick(variantScalars, /^size$/i),
    styleName: pick(variantScalars, /^styleName$/i, /^name$/i, /^label$/i),
  };
  VF.imagesRel = (variantFields.find((f) => f.type.endsWith('[]') && /image/i.test(f.type)) || {}).name || null;
  mode = 'variant-model';
} else if (F.groupId) {
  mode = 'grouped-product-rows';
} else {
  mode = 'single-row';
}

const priceAvailable = mode === 'variant-model' ? Boolean(F.price || VF.price) : Boolean(F.price);
if (!priceAvailable) {
  fail(
    'Could not find a recognizable price field on Product' +
      (variantModelName ? ' or on ' + variantModelName : '') +
      '. Edit the FIELD MAP section of this script by hand instead of relying on auto-detection.'
  );
}

// ---------- 4. Reuse existing conventions: prisma client + asyncHandler ----------
function findExport(symbol) {
  const files = walk(SRC).filter((f) => /\.tsx?$/.test(f));
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    if (new RegExp('export\\s+(?:const|function|async function|class)\\s+' + symbol + '\\b').test(text)) {
      return file;
    }
  }
  return null;
}

const prismaFile = findExport('prisma');
if (!prismaFile) fail('Could not find an exported "prisma" client anywhere under src/.');
const asyncHandlerFile = findExport('asyncHandler');

// ---------- 5. Write the new route file ----------
const outDir = path.join(SRC, 'modules', 'feeds');
const outFile = path.join(outDir, 'feeds.routes.ts');
if (fs.existsSync(outFile) && !FORCE) {
  fail(path.relative(root, outFile) + ' already exists. Re-run with --force to regenerate it.');
}

const prismaImport = relImport(outFile, prismaFile);
const useHandler = Boolean(asyncHandlerFile);
const asyncHandlerImport = useHandler ? relImport(outFile, asyncHandlerFile) : null;

function q(s) {
  return "'" + s + "'";
}

const lines = [];
lines.push('// AUTO-GENERATED by SANDMAN-GOOGLE-MERCHANT-FEED-V1.0.0.');
lines.push('// Safe to hand-edit afterwards; re-running the installer will not overwrite this');
lines.push('// file unless you pass --force.');
lines.push('//');
lines.push('// Serves a tab-separated Google Merchant Center product feed for scheduled fetch.');
lines.push("import { Router } from 'express';");
lines.push('import { prisma } from ' + q(prismaImport) + ';');
if (useHandler) lines.push('import { asyncHandler } from ' + q(asyncHandlerImport) + ';');
lines.push('');
lines.push('export const feedsRouter = Router();');
lines.push('');
lines.push('const CURRENCY = ' + q('USD') + '; // TODO: change if you sell in a different currency');
lines.push('const SITE_URL = ' + q('https://yourstore.com') + '; // TODO: set your real storefront domain');
lines.push('const PAGE_SIZE = 500;');
lines.push('');
lines.push('function tsv(value) {');
lines.push('  if (value === null || value === undefined) return \'\';');
lines.push("  return String(value).replace(/[\\t\\n\\r]/g, ' ').trim();");
lines.push('}');
lines.push('');
lines.push('function money(value, currency) {');
lines.push('  return value === null || value === undefined ? \'\' : Number(value).toFixed(2) + \' \' + (currency || CURRENCY);');
lines.push('}');
lines.push('');
lines.push('const CONDITION_MAP = { NEW: ' + q('new') + ', USED: ' + q('used') + ', REFURBISHED: ' + q('refurbished') + ', REMANUFACTURED: ' + q('refurbished') + ' };');
lines.push('function condition(value) {');
lines.push('  if (value === null || value === undefined) return ' + q('new') + ';');
lines.push('  return CONDITION_MAP[value] || String(value).toLowerCase();');
lines.push('}');
lines.push('');

const columns = [
  'id',
  'title',
  'description',
  'link',
  'image_link',
  'additional_image_link',
  'availability',
  'price',
  'sale_price',
  'brand',
  'gtin',
  'mpn',
  'condition',
  'item_group_id',
  'color',
  'size',
  'google_product_category',
];

lines.push('const FEED_COLUMNS = [');
for (const c of columns) lines.push('  ' + q(c) + ',');
lines.push('];');
lines.push('');

function moneyFieldExpr(v, fieldName, isCents) {
  const access = v + '.' + fieldName;
  return isCents ? '(' + access + ' == null ? null : ' + access + ' / 100)' : access;
}

function currencyArgExpr(v) {
  return F.currency ? ', ' + v + '.' + F.currency : '';
}

function conditionExpr(v, conditionField) {
  return conditionField ? 'condition(' + v + '.' + conditionField + ')' : q('new');
}

function availabilityExpr(varName, stockField, statusField) {
  if (stockField) return varName + '.' + stockField + ' > 0 ? ' + q('in_stock') + ' : ' + q('out_of_stock');
  if (statusField) return varName + '.' + statusField + " === 'ACTIVE' ? " + q('in_stock') + ' : ' + q('out_of_stock');
  return q('in_stock') + " /* TODO: no stock or status field detected, defaulting everything to in_stock */";
}

function linkExpr(pVar) {
  if (F.slug) return "SITE_URL + '/products/' + " + pVar + '.' + F.slug;
  return "SITE_URL + '/products/' + " + pVar + '.id';
}

function imagesExpr(pVar, relName) {
  if (!relName) return { first: q(''), rest: q('') };
  return {
    first: pVar + '.' + relName + '[0]?.url ?? \'\'',
    rest: pVar + '.' + relName + '.slice(1, 11).map(i => i.url).join(\',\')',
  };
}

lines.push('router_handler_placeholder');
const handlerOpen = useHandler
  ? "feedsRouter.get('/google-merchant.txt', asyncHandler(async (req, res) => {"
  : "feedsRouter.get('/google-merchant.txt', async (req, res) => {";
lines[lines.length - 1] = handlerOpen;

lines.push("  res.setHeader('Content-Type', 'text/tab-separated-values; charset=utf-8');");
lines.push("  res.write(FEED_COLUMNS.join('\\t') + '\\n');");
lines.push('');
lines.push('  let cursor;');
lines.push('  while (true) {');

if (mode === 'variant-model') {
  const modelAccessor = variantModelName[0].toLowerCase() + variantModelName.slice(1);
  const includeParts = [relField + ': true'];
  if (VF.imagesRel) includeParts.push(VF.imagesRel + ': true');
  lines.push('    const rows = await prisma.' + modelAccessor + '.findMany({');
  lines.push('      take: PAGE_SIZE,');
  lines.push('      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),');
  lines.push("      orderBy: { id: 'asc' },");
  lines.push('      include: { ' + includeParts.join(', ') + ' },');
  lines.push('    });');
  lines.push('    if (!rows.length) break;');
  lines.push('');
  lines.push('    for (const v of rows) {');
  lines.push('      const p = v.' + relField + ';');
  const imgs = imagesExpr('v', VF.imagesRel || F.imagesRel);
  const groupIdExpr = VF.fkId ? 'v.' + VF.fkId : 'p.id';
  const idExpr = VF.sku ? 'v.' + VF.sku : 'v.id';
  const titleExpr = VF.styleName
    ? 'p.' + F.title + ' + (v.' + VF.styleName + ' ? \' - \' + v.' + VF.styleName + " : '')"
    : 'p.' + F.title;
  lines.push('      const row = [');
  lines.push('        ' + idExpr + ',');
  lines.push('        ' + titleExpr + ',');
  lines.push('        p.' + F.description + ',');
  lines.push('        ' + linkExpr('p') + ',');
  lines.push('        ' + imgs.first + ',');
  lines.push('        ' + imgs.rest + ',');
  const priceVar = VF.price ? 'v' : 'p';
  const priceName = VF.price || F.price;
  const priceCents = VF.price ? VF.priceCents : F.priceCents;
  lines.push('        ' + availabilityExpr('v', VF.stock, F.status) + ',');
  lines.push('        money(' + moneyFieldExpr(priceVar, priceName, priceCents) + currencyArgExpr('p') + '),');
  lines.push('        ' + (F.salePrice ? 'money(' + moneyFieldExpr('p', F.salePrice, F.salePriceCents) + currencyArgExpr('p') + ')' : "''") + ',');
  lines.push('        ' + (F.brand ? 'p.' + F.brand + " ?? ''" : q('')) + ',');
  lines.push('        ' + (VF.gtin ? 'v.' + VF.gtin + " ?? ''" : F.gtin ? 'p.' + F.gtin + " ?? ''" : q('')) + ',');
  const conditionVar = VF.condition ? 'v' : 'p';
  const conditionField = VF.condition || F.condition;
  lines.push('        ' + (F.mpn ? 'p.' + F.mpn + " ?? ''" : idExpr) + ',');
  lines.push('        ' + conditionExpr(conditionVar, conditionField) + ',');
  lines.push('        ' + groupIdExpr + ',');
  lines.push('        ' + (VF.color ? 'v.' + VF.color + " ?? ''" : q('')) + ',');
  lines.push('        ' + (VF.size ? 'v.' + VF.size + " ?? ''" : q('')) + ',');
  lines.push('        ' + (F.category ? 'p.' + F.category + " ?? ''" : q('')) + ',');
  lines.push('      ].map(tsv);');
  lines.push("      res.write(row.join('\\t') + '\\n');");
  lines.push('    }');
  lines.push('');
  lines.push('    cursor = rows[rows.length - 1].id;');
  lines.push('    if (rows.length < PAGE_SIZE) break;');
} else {
  const includeParts = [];
  if (F.imagesRel) includeParts.push(F.imagesRel + ': true');
  const includeBlock = includeParts.length ? '\n      include: { ' + includeParts.join(', ') + ' },' : '';
  const whereBlock = F.status ? "\n      where: { " + F.status + ": 'ACTIVE' }," : '';
  lines.push('    const rows = await prisma.product.findMany({');
  lines.push('      take: PAGE_SIZE,');
  lines.push('      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),');
  lines.push("      orderBy: { id: 'asc' }," + whereBlock + includeBlock);
  lines.push('    });');
  lines.push('    if (!rows.length) break;');
  lines.push('');
  lines.push('    for (const p of rows) {');
  const imgs = imagesExpr('p', F.imagesRel);
  const groupIdExpr = mode === 'grouped-product-rows' ? 'p.' + F.groupId + ' ?? p.id' : "''";
  lines.push('      const row = [');
  lines.push('        p.id,');
  lines.push('        p.' + F.title + ',');
  lines.push('        p.' + F.description + ',');
  lines.push('        ' + linkExpr('p') + ',');
  lines.push('        ' + imgs.first + ',');
  lines.push('        ' + imgs.rest + ',');
  lines.push('        ' + availabilityExpr('p', F.stock, F.status) + ',');
  lines.push('        money(' + moneyFieldExpr('p', F.price, F.priceCents) + currencyArgExpr('p') + '),');
  lines.push('        ' + (F.salePrice ? 'money(' + moneyFieldExpr('p', F.salePrice, F.salePriceCents) + currencyArgExpr('p') + ')' : "''") + ',');
  lines.push('        ' + (F.brand ? 'p.' + F.brand + " ?? ''" : q('')) + ',');
  lines.push('        ' + (F.gtin ? 'p.' + F.gtin + " ?? ''" : q('')) + ',');
  lines.push('        ' + (F.mpn ? 'p.' + F.mpn + " ?? ''" : 'p.id') + ',');
  lines.push('        ' + conditionExpr('p', F.condition) + ',');
  lines.push('        ' + groupIdExpr + ',');
  lines.push('        ' + (F.color ? 'p.' + F.color + " ?? ''" : q('')) + ',');
  lines.push('        ' + (F.size ? 'p.' + F.size + " ?? ''" : q('')) + ',');
  lines.push('        ' + (F.category ? 'p.' + F.category + " ?? ''" : q('')) + ',');
  lines.push('      ].map(tsv);');
  lines.push("      res.write(row.join('\\t') + '\\n');");
  lines.push('    }');
  lines.push('');
  lines.push('    cursor = rows[rows.length - 1].id;');
  lines.push('    if (rows.length < PAGE_SIZE) break;');
}

lines.push('  }');
lines.push('');
lines.push('  res.end();');
lines.push(useHandler ? '}));' : '});');
lines.push('');

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outFile, lines.join('\n'), 'utf8');
console.log('Wrote ' + path.relative(root, outFile));

// ---------- 6. Report the field mapping used ----------
console.log('');
console.log('Field mapping detected from ' + schemaRel + ':');
for (const [k, v] of Object.entries(F)) console.log('  ' + k + ': ' + (v ?? '(not found)'));
console.log('Style/variant mode: ' + mode + (variantModelName ? ' (' + variantModelName + ')' : ''));
if (mode === 'variant-model') {
  console.log('Variant field mapping:');
  for (const [k, v] of Object.entries(VF)) console.log('  ' + k + ': ' + (v ?? '(not found)'));
}
console.log('');

// ---------- 7. Try to auto-wire the router into the app ----------
function findFilesImporting(symbol) {
  const files = walk(SRC).filter((f) => /\.tsx?$/.test(f));
  const re = new RegExp('import\\s*\\{[^}]*\\b' + symbol + '\\b[^}]*\\}\\s*from');
  return files.filter((f) => re.test(fs.readFileSync(f, 'utf8')));
}

let wired = false;
const candidates = findFilesImporting('experienceRouter');
if (candidates.length === 1) {
  const appFile = candidates[0];
  const rawText = fs.readFileSync(appFile, 'utf8');
  const hadCRLF = rawText.includes('\r\n');
  let text = rawText.replace(/\r\n/g, '\n');
  const importLineRe = /^import\s*\{[^}]*\bexperienceRouter\b[^}]*\}\s*from\s*['"][^'"]+['"];?\s*$/m;
  const mountLineRe = /^\s*[\w.]+\.use\([^)]*experienceRouter[^)]*\);\s*$/gm;
  const importMatch = text.match(importLineRe);
  const mountMatches = text.match(mountLineRe) || [];
  if (importMatch && mountMatches.length === 1 && !text.includes('feedsRouter')) {
    const captureRe = /^(\s*)([\w.]+)\.use\([^)]*experienceRouter[^)]*\);\s*$/m;
    const capture = text.match(captureRe);
    const feedsImportSpecifier = relImport(appFile, outFile);
    const newImportLine = "import { feedsRouter } from '" + feedsImportSpecifier + "';";
    text = text.replace(importMatch[0], importMatch[0] + '\n' + newImportLine);
    const newMountLine = capture[1] + capture[2] + ".use('/feeds', feedsRouter);";
    text = text.replace(mountMatches[0], mountMatches[0] + '\n' + newMountLine);
    if (hadCRLF) text = text.replace(/\n/g, '\r\n');
    fs.writeFileSync(appFile, text, 'utf8');
    wired = true;
    console.log('Auto-wired feedsRouter into ' + path.relative(root, appFile));
  }
}

if (!wired) {
  console.log('Could not safely auto-wire the router (no single unambiguous mount point found).');
  console.log('Add these two lines yourself, next to where experienceRouter is mounted:');
  console.log("  import { feedsRouter } from '<relative path to>/modules/feeds/feeds.routes';");
  console.log("  app.use('/feeds', feedsRouter);");
}

console.log('');
console.log('SANDMAN Google Merchant feed V1.0.0 applied.');
console.log('Feed will be served at /feeds/google-merchant.txt once mounted and deployed.');
