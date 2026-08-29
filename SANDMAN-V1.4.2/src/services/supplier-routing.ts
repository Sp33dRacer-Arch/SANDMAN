import { prisma } from '../lib/prisma';
import { HttpError } from '../lib/http-error';
import { env } from '../config/env';

export async function chooseSupplierForProduct(productId: string, quantity: number) {
  const links = await prisma.supplierProduct.findMany({
    where: {
      productId,
      active: true,
      currency: env.CURRENCY.toUpperCase(),
      supplier: { active: true },
      OR: [{ availableStock: null }, { availableStock: { gte: quantity } }],
    },
    include: { supplier: true },
    orderBy: [
      { supplier: { priority: 'asc' } },
      { costCents: 'asc' },
      { shippingCents: 'asc' },
    ],
  });
  if (!links.length) throw new HttpError(409, 'No supplier can currently fulfill this product');
  const preferredCode = env.DEFAULT_SUPPLIER.trim().toLowerCase();
  const preferred = links.find(link => link.supplier.code.trim().toLowerCase() === preferredCode);
  return preferred ?? links[0]!;
}
