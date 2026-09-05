import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
const days = Math.max(7, Math.min(3650, Number(process.env.ANALYTICS_RETENTION_DAYS || 365)));
const cutoff = new Date(Date.now() - days * 86_400_000);
try {
  const deleted = await prisma.analyticsEvent.deleteMany({ where: { createdAt: { lt: cutoff } } });
  console.log(`Deleted ${deleted.count} analytics event(s) older than ${days} days (${cutoff.toISOString()}).`);
} finally {
  await prisma.$disconnect();
}
