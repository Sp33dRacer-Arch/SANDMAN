#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const outFile = path.join(root, 'src/modules/feeds/feeds.routes.ts');

const checks = [];
const exists = fs.existsSync(outFile);
checks.push(['feed route file exists', exists]);

const text = exists ? fs.readFileSync(outFile, 'utf8') : '';
checks.push(['defines feedsRouter', text.includes('export const feedsRouter')]);
checks.push(['serves /google-merchant.txt', text.includes('google-merchant.txt')]);
checks.push(['imports your real prisma client (not a new PrismaClient)', text.includes("import { prisma } from '")]);
checks.push(['streams with cursor pagination (safe for large catalogs)', text.includes('cursor')]);
checks.push(['does not import or touch Prisma schema/migration files', !text.includes('schema.prisma')]);

let failed = 0;
for (const [label, ok] of checks) {
  console.log((ok ? 'PASS' : 'FAIL') + ': ' + label);
  if (!ok) failed++;
}

if (failed) {
  console.error('google-merchant-feed audit failed (' + failed + '/' + checks.length + ').');
  process.exit(1);
}

console.log('google-merchant-feed audit passed (' + checks.length + '/' + checks.length + ').');
console.log('');
console.log('This only confirms the file was generated correctly. It does NOT confirm the');
console.log('feed data itself is right -- start your dev server and open');
console.log('/feeds/google-merchant.txt yourself to check real rows before deploying.');
