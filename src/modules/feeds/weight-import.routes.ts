import { Router } from 'express';
import { prisma } from '../../lib/prisma';
import { asyncHandler } from '../../lib/async-handler';

const router = Router();

type WeightMatch = {
  raw: string;
  grams: number;
  source: 'name' | 'description' | 'specs';
};

function extractWeights(
  text: string,
  source: WeightMatch['source'],
): WeightMatch[] {
  const matches: WeightMatch[] = [];

  const regex =
    /(\d+(?:\.\d+)?)\s*[-]?\s*(kg|kilograms?|g|grams?|lb|lbs|pounds?)(?![a-z])/gi;

  for (const match of text.matchAll(regex)) {
    const valueText = match[1];
    const unitText = match[2];

    if (!valueText || !unitText) continue;

    const value = Number(valueText);
    const unit = unitText.toLowerCase();

    if (!Number.isFinite(value) || value <= 0) continue;

    // Reject compact product/part codes such as 5788G, 9705G, 6822G.
    if (
      unit === 'g' &&
      /^\d+(?:\.\d+)?\s*g$/i.test(match[0]) === false
    ) {
      continue;
    }

    // If the value is immediately attached to G with no decimal/space,
    // treat large values as product codes rather than gram weights.
    if (
      unit === 'g' &&
      value >= 100 &&
      /^\d+g$/i.test(match[0].trim())
    ) {
      continue;
    }

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

    matches.push({
      raw: match[0],
      grams: Math.round(grams),
      source,
    });
  }

  return matches;
}

router.get(
  '/import-product-weights',
  asyncHandler(async (req, res) => {
    const BATCH_SIZE = 500;

    let cursor =
      typeof req.query.afterId === 'string'
        ? req.query.afterId
        : undefined;

    let scanned = 0;
    let updated = 0;
    let skipped = 0;

    const examples: Array<{
      sku: string;
      name: string;
      detected: string;
      grams: number;
      source: string;
    }> = [];

    while (true) {
      const products = await prisma.product.findMany({
        where: {
          status: 'ACTIVE',
          weightGrams: null,

          ...(cursor
            ? {
                id: {
                  gt: cursor,
                },
              }
            : {}),
        },

        select: {
          id: true,
          sku: true,
          name: true,
          description: true,
          specs: true,
        },

        orderBy: {
          id: 'asc',
        },

        take: BATCH_SIZE,
      });

      if (products.length === 0) break;

      for (const product of products) {
        scanned++;

        const found: WeightMatch[] = [];

        found.push(
          ...extractWeights(product.name, 'name'),
        );

        found.push(
          ...extractWeights(
            product.description || '',
            'description',
          ),
        );

        if (product.specs) {
          found.push(
            ...extractWeights(
              JSON.stringify(product.specs),
              'specs',
            ),
          );
        }

        /*
         * Only use the first detected weight.
         * Products with no detected weight are skipped.
         */
        const first = found[0];

        if (!first) {
          skipped++;
          continue;
        }

        await prisma.product.update({
          where: {
            id: product.id,
          },
          data: {
            weightGrams: first.grams,
          },
        });

        updated++;

        if (examples.length < 20) {
          examples.push({
            sku: product.sku,
            name: product.name,
            detected: first.raw,
            grams: first.grams,
            source: first.source,
          });
        }
      }

      const last = products[products.length - 1];

      if (!last) break;

      cursor = last.id;

      if (products.length < BATCH_SIZE) break;
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
      lastId: cursor ?? null,
      examples,
      message:
        remaining > 0
          ? 'Batch completed. Run again to continue.'
          : 'All active products now have weights.',
    });
  }),
);

export const weightImportRouter = router;