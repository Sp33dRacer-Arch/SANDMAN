import { Router } from 'express';
import { prisma } from '../../lib/prisma';
import { asyncHandler } from '../../lib/async-handler';

const router = Router();

function extractWeight(text: string): number | null {
  // Intentionally ignore bare "g"/"G" because automotive descriptions
  // commonly use G for product/spec designations.
  const regex =
    /(\d+(?:\.\d+)?)\s*[-]?\s*(kg|kilograms?|grams?|lb|lbs|pounds?)(?![a-z])/gi;

  const matches = [...text.matchAll(regex)];
  const weights: number[] = [];

  for (const match of matches) {
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

    if (grams < 2 || grams > 100000) continue;

    weights.push(Math.round(grams));
  }

  const uniqueWeights = [...new Set(weights)];

  // Only automatically import if there is exactly ONE weight
  // in the product data.
  if (uniqueWeights.length !== 1) {
    return null;
  }

  return uniqueWeights[0] ?? null;
}

router.post(
  '/import-product-weights',
  asyncHandler(async (_req, res) => {
    const LIMIT = 500;

    const products = await prisma.product.findMany({
      where: {
        status: 'ACTIVE',
        weightGrams: null,
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
      take: LIMIT,
    });

    let updated = 0;
    let skipped = 0;

    const updates: Array<{
      id: string;
      weightGrams: number;
    }> = [];

    for (const product of products) {
      const text = `${product.name}\n${product.description || ''}`;

      const weightGrams = extractWeight(text);

      if (weightGrams === null) {
        skipped++;
        continue;
      }

      updates.push({
        id: product.id,
        weightGrams,
      });
    }

    // Update in one database transaction instead of thousands
    // of separate requests.
    if (updates.length > 0) {
      await prisma.$transaction(
        updates.map((item) =>
          prisma.product.update({
            where: {
              id: item.id,
            },
            data: {
              weightGrams: item.weightGrams,
            },
          }),
        ),
      );

      updated = updates.length;
    }

    const remaining = await prisma.product.count({
      where: {
        status: 'ACTIVE',
        weightGrams: null,
      },
    });

    res.json({
      success: true,
      databaseModified: true,
      processed: products.length,
      updated,
      skipped,
      remainingProductsWithoutWeight: remaining,
      message:
        remaining > 0
          ? 'Run this endpoint again to process the next batch.'
          : 'All eligible products have been processed.',
    });
  }),
);

export const weightImportRouter = router;