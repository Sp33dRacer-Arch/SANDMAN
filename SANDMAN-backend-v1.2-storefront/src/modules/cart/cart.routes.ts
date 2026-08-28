import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { asyncHandler } from '../../lib/async-handler';
import { HttpError } from '../../lib/http-error';
import { requireAuth } from '../../middleware/auth';

export const cartRouter = Router();
cartRouter.use(requireAuth);

async function getCart(userId: string) {
  return prisma.cart.upsert({
    where: { userId },
    update: {},
    create: { userId },
    include: {
      items: {
        include: {
          product: {
            include: {
              images: { orderBy: { position: 'asc' }, take: 1 },
              seller: { select: { id: true, firstName: true, lastName: true } },
            },
          },
        },
        orderBy: { createdAt: 'asc' },
      },
    },
  });
}

cartRouter.get('/', asyncHandler(async (req, res) => {
  const cart = await getCart(req.auth!.userId);
  res.json({
    ...cart,
    subtotalCents: cart.items.reduce((s, i) => s + i.product.priceCents * i.quantity, 0),
    marketplaceShippingCents: cart.items.reduce((s, i) => s + (i.product.sourceType === 'MARKETPLACE' ? i.product.sellerShippingCents * i.quantity : 0), 0),
  });
}));

cartRouter.post('/items', asyncHandler(async (req, res) => {
  const data = z.object({
    productId: z.string().min(1),
    quantity: z.number().int().min(1).max(20).default(1),
    vehicleVariantId: z.string().optional(),
  }).parse(req.body);

  const product = await prisma.product.findFirst({
    where: { id: data.productId, status: 'ACTIVE' },
    include: { fitments: { select: { vehicleVariantId: true } }, supplierLinks: { where: { active: true } } },
  });
  if (!product) throw new HttpError(404, 'Product not found');
  if (product.sourceType === 'MARKETPLACE' && product.sellerId === req.auth!.userId) {
    throw new HttpError(409, 'You cannot buy your own marketplace listing');
  }

  if (product.sourceType === 'DROPSHIP' && !product.supplierLinks.length) {
    throw new HttpError(409, 'Product is temporarily unavailable');
  }
  if (product.sourceType === 'MARKETPLACE' && (product.stockQuantity ?? 0) < data.quantity) {
    throw new HttpError(409, 'Seller does not have enough stock for this quantity');
  }

  if (product.requiresFitment && !product.isUniversal) {
    if (!data.vehicleVariantId) throw new HttpError(400, 'Vehicle selection is required for this part');
    const compatible = product.fitments.some(f => f.vehicleVariantId === data.vehicleVariantId);
    if (!compatible) throw new HttpError(409, 'This part does not fit the selected vehicle');
  }

  const cart = await prisma.cart.upsert({ where: { userId: req.auth!.userId }, update: {}, create: { userId: req.auth!.userId } });
  const existing = await prisma.cartItem.findUnique({ where: { cartId_productId: { cartId: cart.id, productId: product.id } } });
  const targetQuantity = (existing?.quantity ?? 0) + data.quantity;
  if (product.sourceType === 'MARKETPLACE' && targetQuantity > (product.stockQuantity ?? 0)) {
    throw new HttpError(409, 'Seller does not have enough stock for this quantity');
  }

  await prisma.cartItem.upsert({
    where: { cartId_productId: { cartId: cart.id, productId: product.id } },
    create: { cartId: cart.id, productId: product.id, quantity: data.quantity, fitmentVehicleVariantId: data.vehicleVariantId },
    update: { quantity: targetQuantity, fitmentVehicleVariantId: data.vehicleVariantId },
  });
  res.status(201).json(await getCart(req.auth!.userId));
}));

cartRouter.patch('/items/:id', asyncHandler(async (req, res) => {
  const { quantity } = z.object({ quantity: z.number().int().min(1).max(20) }).parse(req.body);
  const item = await prisma.cartItem.findFirst({
    where: { id: req.params.id, cart: { userId: req.auth!.userId } },
    include: { product: true },
  });
  if (!item) throw new HttpError(404, 'Cart item not found');
  if (item.product.sourceType === 'MARKETPLACE' && quantity > (item.product.stockQuantity ?? 0)) {
    throw new HttpError(409, 'Seller does not have enough stock for this quantity');
  }
  await prisma.cartItem.update({ where: { id: item.id }, data: { quantity } });
  res.json(await getCart(req.auth!.userId));
}));

cartRouter.delete('/items/:id', asyncHandler(async (req, res) => {
  const deleted = await prisma.cartItem.deleteMany({ where: { id: req.params.id, cart: { userId: req.auth!.userId } } });
  if (!deleted.count) throw new HttpError(404, 'Cart item not found');
  res.status(204).send();
}));
