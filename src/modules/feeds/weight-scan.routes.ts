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

router.get(
  '/scan-product-weights',
  asyncHandler(async (_req, res) => {
    const total = await prisma.product.count({
      where: {
        status: 'ACTIVE',
      },
    });

    let scanned = 0;
    let withDetectedWeight = 0;
    let withoutDetectedWeight = 0;

    const unitCounts = {
      grams: 0,
      kilograms: 0,
      pounds: 0,
    };

    const examples: Array<{
      sku: string;
      name: string;
      detected: string;
      grams: number;
    }> = [];

    const BATCH_SIZE = 1000;
    let cursor: string | undefined;

    while (true) {
      const products = await prisma.product.findMany({
        where: {
          status: 'ACTIVE',
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

      for (const product of products) {
        scanned++;

        const text = `${product.name}\n${product.description || ''}`;
        const matches = extractWeights(text);

        if (matches.length > 0) {
          withDetectedWeight++;

          for (const match of matches) {
            const unit = match.raw.toLowerCase();

            if (
              unit.includes('kg') ||
              unit.includes('kilogram')
            ) {
              unitCounts.kilograms++;
            } else if (
              unit.includes('lb') ||
              unit.includes('pound')
            ) {
              unitCounts.pounds++;
            } else {
              unitCounts.grams++;
            }
          }

          const first = matches[0];

          if (first && examples.length < 100) {
            examples.push({
              sku: product.sku,
              name: product.name,
              detected: first.raw,
              grams: first.grams,
            });
          }
        } else {
          withoutDetectedWeight++;
        }
      }

      const last = products[products.length - 1];

      if (!last) break;

      cursor = last.id;

      if (products.length < BATCH_SIZE) break;
    }

    res.json({
      readOnly: true,
      databaseModified: false,
      totalActiveProducts: total,
      scanned,
      productsWithDetectedWeight: withDetectedWeight,
      productsWithoutDetectedWeight: withoutDetectedWeight,
      detectedUnits: unitCounts,
      examples,
    });
  }),
);

export const weightScanRouter = router;