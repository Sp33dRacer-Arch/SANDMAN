import { prisma } from '../lib/prisma';

export async function recommendedRetailPrice(input: { supplierId?: string | null; categoryId?: string | null; costCents: number; shippingCents?: number }) {
  const landed = Math.max(0, input.costCents + (input.shippingCents ?? 0));
  const rules = await prisma.pricingRule.findMany({
    where: {
      active: true,
      AND: [
        { OR: [{ supplierId: null }, ...(input.supplierId ? [{ supplierId: input.supplierId }] : [])] },
        { OR: [{ categoryId: null }, ...(input.categoryId ? [{ categoryId: input.categoryId }] : [])] },
      ],
    },
    orderBy: { priority: 'asc' },
  });
  const rule = rules[0];
  if (!rule) return landed;
  const percent = rule.markupPercent ? Math.round(landed * (rule.markupPercent / 100)) : 0;
  const fixed = rule.fixedMarkupCents ?? 0;
  const minimum = rule.minimumProfitCents ?? 0;
  return landed + Math.max(percent + fixed, minimum);
}
