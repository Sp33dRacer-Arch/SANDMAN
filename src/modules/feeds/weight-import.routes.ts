import { Router } from 'express';
import { prisma } from '../../lib/prisma';
import { asyncHandler } from '../../lib/async-handler';

const router = Router();

function extractWeight(text: string): number | null {
  // Ignore bare "g"/"G" because automotive specs often use G
  // for things that are NOT product weight.
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

  if (uniqueWeights.length !== 1) {
    return null;
  }

  return uniqueWeights[0] ?? null;
}

router.post(
  '/import-product-weights',
  asyncHandler(async (_req, res) => {
    const SCAN_BATCH = 5000;
    const UPDATE_BATCH = 500;

    let cursor: string | undefined;

    let scanned = 0;
    let updated = 0;
    let skipped = 0;

    while (true) {
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
        take: SCAN_BATCH,
        ...(cursor
          ? {
              skip: 1,
              cursor: {
                id: cursor,
              },
            }
          : {}),
      });

      if (products.length === 0) break;

      const updates: Array<{
        id: string;
        weightGrams: number;
      }> = [];

      for (const product of products) {
        scanned++;

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

      for (let i = 0; i < updates.length; i += UPDATE_BATCH) {
        const batch = updates.slice(i, i + UPDATE_BATCH);

        await prisma.$transaction(
          batch.map((item) =>
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

        updated += batch.length;
      }

      const last = products[products.length - 1];

      if (!last) break;

      cursor = last.id;

      console.log(
        `Weight import: ${scanned} scanned, ${updated} updated, ${skipped} skipped`,
      );

      if (products.length < SCAN_BATCH) break;
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
      scanned,
      updated,
      skipped,
      remainingProductsWithoutWeight: remaining,
      message:
        remaining > 0
          ? 'Run again to continue.'
          : 'Finished processing all active products.',
    });
  }),
);

export const weightImportRouter = router;
