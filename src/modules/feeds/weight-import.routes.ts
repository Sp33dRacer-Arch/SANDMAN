import { Router } from 'express';
import { prisma } from '../../lib/prisma';
import { asyncHandler } from '../../lib/async-handler';

const router = Router();

function extractWeights(text: string) {
  const matches: Array<{
    raw: string;
    grams: number;
  }> = [];

  const regex =
    /(\d+(?:\.\d+)?)\s*[-]?\s*(kg|kilograms?|g|grams?|lb|lbs|pounds?)(?![a-z])/gi;

  for (const match of text.matchAll(regex)) {
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

    matches.push({
      raw: match[0],
      grams: Math.round(grams),
    });
  }

  return matches;
}

router.post(
  '/import-product-weights',
  asyncHandler(async (req, res) => {
    const SCAN_BATCH_SIZE = 1000;

    // Stop this HTTP request after enough work has been done.
    // This prevents Railway timeouts.
    const MAX_SCANNED_PER_REQUEST = 10000;
    const MAX_UPDATES_PER_REQUEST = 1000;

    let scanned = 0;
    let updated = 0;
    let skipped = 0;

    let cursor =
      typeof req.query.afterId === 'string'
        ? req.query.afterId
        : undefined;

    let lastScannedId: string | undefined;

    while (
      scanned < MAX_SCANNED_PER_REQUEST &&
      updated < MAX_UPDATES_PER_REQUEST
    ) {
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
        },

        orderBy: {
          id: 'asc',
        },

        take: SCAN_BATCH_SIZE,
      });

      if (products.length === 0) {
        break;
      }

      for (const product of products) {
        scanned++;
        lastScannedId = product.id;

        const text =
          `${product.name}\n${product.description || ''}`;

        const matches = extractWeights(text);

        /*
         * IMPORTANT:
         *
         * Use the FIRST detected weight, exactly like
         * the read-only scanner.
         *
         * Do NOT reject products merely because multiple
         * weight-looking values exist.
         */
        const first = matches[0];

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

        if (updated >= MAX_UPDATES_PER_REQUEST) {
          break;
        }

        if (scanned >= MAX_SCANNED_PER_REQUEST) {
          break;
        }
      }

      if (products.length < SCAN_BATCH_SIZE) {
        break;
      }

      if (!lastScannedId) {
        break;
      }

      cursor = lastScannedId;
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
      databaseModified: updated > 0,

      scanned,
      updated,
      skipped,

      productsWithWeight: withWeight,
      remainingProductsWithoutWeight: remaining,

      lastId: lastScannedId ?? null,

      message:
        remaining === 0
          ? 'All active products now have weights.'
          : 'Batch completed. Run again using lastId.',
    });
  }),
);

export const weightImportRouter = router;