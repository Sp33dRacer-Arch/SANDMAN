import { Router } from 'express';
import { prisma } from '../../lib/prisma';
import { asyncHandler } from '../../lib/async-handler';

export const weightsDebugRouter = Router();

weightsDebugRouter.get(
  '/product-weights',
  asyncHandler(async (_req, res) => {
    const total = await prisma.product.count({
      where: {
        status: 'ACTIVE',
      },
    });

    const withWeight = await prisma.product.count({
      where: {
        status: 'ACTIVE',
        weightGrams: {
          not: null,
        },
      },
    });

    const withoutWeight = total - withWeight;

    const missing = await prisma.product.findMany({
      where: {
        status: 'ACTIVE',
        weightGrams: null,
      },
      select: {
        id: true,
        sku: true,
        name: true,
        weightGrams: true,
      },
      take: 20,
      orderBy: {
        id: 'asc',
      },
    });

    res.json({
      totalActiveProducts: total,
      productsWithWeight: withWeight,
      productsWithoutWeight: withoutWeight,
      sampleMissingWeights: missing,
    });
  }),
);