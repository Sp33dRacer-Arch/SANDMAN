import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
const thresholdMb = Number(process.env.DB_STORAGE_ALERT_THRESHOLD_MB || 0);
const webhook = String(process.env.DB_STORAGE_ALERT_WEBHOOK_URL || '').trim();
if (!(thresholdMb > 0) || !webhook) {
  console.error('Set DB_STORAGE_ALERT_THRESHOLD_MB and DB_STORAGE_ALERT_WEBHOOK_URL.');
  process.exit(2);
}
try {
  const rows = await prisma.$queryRaw`SELECT pg_database_size(current_database()) AS bytes`;
  const bytes = Number(rows?.[0]?.bytes || 0);
  const mb = bytes / 1024 / 1024;
  console.log(`Database size: ${mb.toFixed(1)} MB; alert threshold: ${thresholdMb} MB.`);
  if (mb >= thresholdMb) {
    const response = await fetch(webhook, {
      method:'POST', headers:{'content-type':'application/json'},
      body:JSON.stringify({type:'SANDMAN_DATABASE_GROWTH_ALERT',version:'2.5.0',databaseSizeMb:Number(mb.toFixed(1)),thresholdMb,timestamp:new Date().toISOString()}),
      signal:AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Alert webhook failed (${response.status})`);
    console.log('Database growth alert delivered.');
  }
} finally {
  await prisma.$disconnect();
}
