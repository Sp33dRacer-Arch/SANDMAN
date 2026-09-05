import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
const url = String(process.env.ANALYTICS_WAREHOUSE_URL || '').trim();
const secret = String(process.env.ANALYTICS_WAREHOUSE_SECRET || '').trim();
const hours = Math.max(1, Math.min(720, Number(process.env.ANALYTICS_EXPORT_LOOKBACK_HOURS || 24)));
if (!url) {
  console.error('ANALYTICS_WAREHOUSE_URL is not configured.');
  process.exit(2);
}
const since = new Date(Date.now() - hours * 3_600_000);
try {
  const events = await prisma.analyticsEvent.findMany({ where: { createdAt: { gte: since } }, orderBy: { createdAt: 'asc' }, take: 5000 });
  let exported = 0;
  for (let i = 0; i < events.length; i += 500) {
    const batch = events.slice(i, i + 500);
    const response = await fetch(url, {
      method:'POST',
      headers:{'content-type':'application/json', ...(secret?{authorization:`Bearer ${secret}`}:{})},
      body:JSON.stringify({type:'SANDMAN_ANALYTICS_BATCH',version:'2.5.0',events:batch}),
      signal:AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Warehouse export failed (${response.status})`);
    exported += batch.length;
  }
  console.log(`Exported ${exported} analytics event(s) from the last ${hours} hour(s). Warehouse should deduplicate by event id.`);
} finally {
  await prisma.$disconnect();
}
