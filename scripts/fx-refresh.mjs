import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
const url = String(process.env.FX_RATE_PROVIDER_URL || '').trim();
const apiKey = String(process.env.FX_RATE_PROVIDER_API_KEY || '').trim();
const base = String(process.env.CURRENCY || 'USD').toUpperCase();
if (!url) {
  console.error('FX_RATE_PROVIDER_URL is not configured.');
  process.exit(2);
}
try {
  const response = await fetch(url, {
    headers:{accept:'application/json', ...(apiKey?{authorization:`Bearer ${apiKey}`}:{})},
    signal:AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`FX provider failed (${response.status})`);
  const payload = await response.json();
  const providerBase = String(payload.base || payload.base_code || base).toUpperCase();
  if (providerBase !== base) throw new Error(`FX provider base ${providerBase} does not match SANDMAN base ${base}`);
  const rates = payload.rates && typeof payload.rates === 'object' ? payload.rates : payload.conversion_rates;
  if (!rates || typeof rates !== 'object') throw new Error('FX provider response does not contain a rates object');
  let count = 0;
  for (const [quote, rawRate] of Object.entries(rates)) {
    const currency = String(quote).toUpperCase();
    const rate = Number(rawRate);
    if (!/^[A-Z]{3}$/.test(currency) || currency === base || !(rate > 0) || !Number.isFinite(rate)) continue;
    await prisma.fxRate.upsert({
      where:{baseCurrency_quoteCurrency:{baseCurrency:base,quoteCurrency:currency}},
      update:{rate,source:'PROVIDER',fetchedAt:new Date()},
      create:{baseCurrency:base,quoteCurrency:currency,rate,source:'PROVIDER',fetchedAt:new Date()},
    });
    count += 1;
  }
  console.log(`Updated ${count} ${base} FX rate(s).`);
} finally {
  await prisma.$disconnect();
}
