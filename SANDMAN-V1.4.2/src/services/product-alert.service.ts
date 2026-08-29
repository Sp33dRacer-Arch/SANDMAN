import { prisma } from '../lib/prisma';
import { createNotification } from './notification.service';
import { sendEmail } from './email.service';

export async function processProductAlerts(input: { productId: string; previousPriceCents?: number; newPriceCents?: number; previousStock?: number | null; newStock?: number | null }) {
  const product = await prisma.product.findUnique({ where: { id: input.productId }, select: { name: true, slug: true, priceCents: true } });
  if (!product) return;
  const alerts = await prisma.productAlert.findMany({ where: { productId: input.productId, active: true }, include: { user: { select: { email: true } } } });
  for (const alert of alerts) {
    const priceTriggered = alert.type === 'PRICE_DROP'
      && input.newPriceCents !== undefined
      && input.previousPriceCents !== undefined
      && input.newPriceCents < input.previousPriceCents
      && input.newPriceCents <= (alert.targetPriceCents ?? input.newPriceCents);
    const stockTriggered = alert.type === 'RESTOCK'
      && (input.previousStock ?? 0) <= 0
      && (input.newStock ?? 0) > 0;
    if (!priceTriggered && !stockTriggered) continue;
    const title = priceTriggered ? 'Price alert' : 'Back in stock';
    const body = priceTriggered ? `${product.name} reached your target price.` : `${product.name} is back in stock.`;
    await createNotification({ userId: alert.userId, type: alert.type, title, body, link: `#/product/${product.slug}` }).catch(() => undefined);
    await sendEmail({ to: alert.user.email, subject: `SANDMAN: ${title}`, text: `${body} ${product.name}`, type: 'ALERT' }).catch(() => undefined);
    await prisma.productAlert.update({ where: { id: alert.id }, data: { lastTriggeredAt: new Date(), ...(alert.type === 'PRICE_DROP' ? { active: false } : {}) } });
  }
}
