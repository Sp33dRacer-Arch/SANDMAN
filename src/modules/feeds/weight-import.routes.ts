import { Router } from 'express';
import { prisma } from '../../lib/prisma';
import { asyncHandler } from '../../lib/async-handler';

const router = Router();

function extractWeight(text: string): number | null {
  const weights: number[] = [];

  /*
   * Explicit weight units.
   *
   * These are safe because they spell out the unit:
   * lb, lbs, pound, pounds
   * kg, kilogram, kilograms
   * g, gram, grams
   *
   * Bare uppercase "G" is intentionally NOT accepted.
   */
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

    if (grams <= 0 || grams > 100000) continue;

    weights.push(Math.round(grams));
  }

  /*
   * Also accept lowercase compact gram notation such as:
   *
   * 2g
   * 9g
   * 118g
   *
   * But deliberately reject:
   *
   * 2G
   * 5G
   * 14G
   *
   * because those commonly represent automotive specifications.
   */
  const compactGramRegex =
    /(\d+(?:\.\d+)?)\s*g(?![a-zA-Z])/g;

  for (const match of text.matchAll(compactGramRegex)) {
    const valueText = match[1];

    if (!valueText) continue;

    const value = Number(valueText);

    if (!Number.isFinite(value) || value <= 0) continue;

    if (value > 100000) continue;

    weights.push(Math.round(value));
  }

  const uniqueWeights = [...new Set(weights)];

  /*
   * If the product description contains multiple different
   * weights, don't guess which one is the shipping weight.
   */
  if (uniqueWeights.length !== 1) {
    return null;
  }

  const weight = uniqueWeights[0];

  if (weight === undefined) {
    return null;
  }

  return weight;
}

router.post(
  '/import-product-weights',
  asyncHandler(async (_req, res) => {
    const SCAN_BATCH = 5000;
    const UPDATE_BATCH = 500;

    let scanned = 0;
    let updated = 0;
    let skipped = 0;

    while (true) {
      /*
       * IMPORTANT:
       *
       * Always start from the first remaining product.
       * Do not use a cursor here because products are being
       * removed from the weightGrams:null result set as we update them.
       */
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
      });

      if (products.length === 0) {
        break;
      }

      const updates: Array<{
        id: string;
        weightGrams: number;
      }> = [];

      for (const product of products) {
        scanned++;

        const text =
          `${product.name}\n${product.description || ''}`;

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

      /*
       * Update in manageable transactions.
       */
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

      console.log(
        `Weight import progress: ` +
          `${scanned.toLocaleString()} scanned, ` +
          `${updated.toLocaleString()} updated, ` +
          `${skipped.toLocaleString()} skipped`,
      );

      /*
       * If fewer than SCAN_BATCH remain, we're finished.
       */
      if (products.length < SCAN_BATCH) {
        break;
      }
    }

    const remaining = await prisma.product.count({
      where: {
        status: 'ACTIVE',
        weightGrams: null,
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

    res.json({
      success: true,
      databaseModified: true,
      scanned,
      updated,
      skipped,
      productsWithWeight: withWeight,
      remainingProductsWithoutWeight: remaining,
      message:
        remaining > 0
          ? 'Run again to continue.'
          : 'All active products now have a weight.',
    });
  }),
);

export const weightImportRouter = router;