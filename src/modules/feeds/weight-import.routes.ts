import { Router } from 'express';
import { prisma } from '../../lib/prisma';
import { asyncHandler } from '../../lib/async-handler';

const router = Router();

function extractWeight(text: string): number | null {
  const weights: number[] = [];

  const explicitRegex =
    /(\d+(?:\.\d+)?)\s*[-]?\s*(kg|kilograms?|grams?|lb|lbs|pounds?)(?![a-z])/gi;

  for (const match of text.matchAll(explicitRegex)) {
    const valueText = match[1];
    const unitText = match[2];

    if (!valueText || !unitText) continue;

    const value = Number(valueText);
    const unit = unitText.toLowerCase();

    if (!Number.isFinite(value) || value <= 0) continue;

    let grams: number;

    if (unit === 'kg' || unit.startsWith('kilogram')) {
      grams = value * 1000;
    } else if (
      unit === 'lb' ||
      unit === 'lbs' ||
      unit.startsWith('pound')
    ) {
      grams = value * 453.59237;
    } else {
      grams = value;
    }

    if (grams > 0 && grams <= 100000) {
      weights.push(Math.round(grams));
    }
  }

  const compactGramRegex =
    /(\d+(?:\.\d+)?)\s*g(?![a-zA-Z])/g;

  for (const match of text.matchAll(compactGramRegex)) {
    const valueText = match[1];

    if (!valueText) continue;

    const value = Number(valueText);

    if (
      Number.isFinite(value) &&
      value > 0 &&
      value <= 100000
    ) {
      weights.push(Math.round(value));
    }
  }

  const uniqueWeights = [...new Set(weights)];

  if (uniqueWeights.length !== 1) {
    return null;
  }

  return uniqueWeights[0] ?? null;
}

router.post(
  '/import-product-weights',
  asyncHandler(async (req, res) => {
    const BATCH_SIZE = 1000;

    const afterId =
      typeof req.query.afterId === 'string'
        ? req.query.afterId
        : undefined;

    const products = await prisma.product.findMany({
      where: {
        status: 'ACTIVE',
        weightGrams: null,
        ...(afterId
          ? {
              id: {
                gt: afterId,
              },
            }
          : {}),
      },
      select: {
        id: true,
        sku: true,
        name: true,
        description: true,
      },
      orderBy: {
        id: 'asc',
      },
      take: BATCH_SIZE,
    });

    let updated = 0;
    let skipped = 0;

    for (const product of products) {
      const text =
        `${product.name}\n${product.description || ''}`;

      const weightGrams = extractWeight(text);

      if (weightGrams === null) {
        skipped++;
        continue;
      }

      await prisma.product.update({
        where: {
          id: product.id,
        },
        data: {
          weightGrams,
        },
      });

      updated++;
    }

    const lastProduct = products.at(-1);

    const remaining = await prisma.product.count({
      where: {
        status: 'ACTIVE',
        weightGrams: null,
        ...(lastProduct
          ? {
              id: {
                gt: lastProduct.id,
              },
            }
          : {}),
      },
    });

    res.json({
      success: true,
      scanned: products.length,
      updated,
      skipped,
      lastId: lastProduct?.id ?? null,
      remainingAfterThisBatch: remaining,
      message:
        products.length === 0
          ? 'No more products in this range.'
          : 'Batch completed. Run again using lastId.',
    });
  }),
);

export const weightImportRouter = router;