import { prisma } from '../lib/prisma';
import { HttpError } from '../lib/http-error';

export async function chooseSupplierForProduct(productId: string, quantity: number) {
  const links = await prisma.supplierProduct.findMany({
    where: {
      productId,
      active: true,
      supplier: { active: true },
      OR: [{ stock: null }, { stock: { gte: quantity } }],
    },
    include: { supplier: true },
    orderBy: [
      { supplier: { priority: 'asc' } },
      { costCents: 'asc' },
      { shippingCents: 'asc' },
    ],
  });
  if (!links.length) throw new HttpError(409, 'No supplier can currently fulfill this product');
  return links[0]!;
}
