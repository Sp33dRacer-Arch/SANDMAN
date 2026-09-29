import { Router } from 'express';
import { prisma } from '../../lib/prisma';
import { asyncHandler } from '../../lib/async-handler';

const router = Router();

function extractWeights(text: string) {
  const matches: Array<{
    raw: string;
    grams: number;
    unit: string;
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
      unit,
    });
  }

  return matches;
}

router.get(
  '/validate-product-weights',
  asyncHandler(async (_req, res) => {
    const BATCH_SIZE = 1000;

    let cursor: string | undefined;
    let scanned = 0;

    const results = {
      total: 0,
      detected: 0,
      noWeight: 0,
      suspicious: 0,
      valid: 0,
    };

    const suspiciousExamples: Array<{
      sku: string;
      name: string;
      detected: string;
      grams: number;
    }> = [];

    const validExamples: Array<{
      sku: string;
      name: string;
      detected: string;
      grams: number;
    }> = [];

    results.total = await prisma.product.count({
      where: {
        status: 'ACTIVE',
      },
    });

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

        if (matches.length === 0) {
          results.noWeight++;
          continue;
        }

        results.detected++;

        const first = matches[0];

        if (!first) continue;

        /*
         * Conservative validation:
         *
         * 10 g - 50 kg is considered plausible.
         * Extremely tiny or extremely heavy values are flagged
         * for manual review rather than automatically trusted.
         */
        const suspicious =
          first.grams < 10 ||
          first.grams > 50000;

        if (suspicious) {
          results.suspicious++;

          if (suspiciousExamples.length < 200) {
            suspiciousExamples.push({
              sku: product.sku,
              name: product.name,
              detected: first.raw,
              grams: first.grams,
            });
          }
        } else {
          results.valid++;

          if (validExamples.length < 200) {
            validExamples.push({
              sku: product.sku,
              name: product.name,
              detected: first.raw,
              grams: first.grams,
            });
          }
        }
      }

      const last = products[products.length - 1];

      if (!last) break;

      cursor = last.id;

      if (products.length < BATCH_SIZE) break;

      if (scanned % 10000 === 0) {
        console.log(
          `Validated ${scanned.toLocaleString()} / ${results.total.toLocaleString()}`,
        );
      }
    }

    res.json({
      readOnly: true,
      databaseModified: false,
      totalActiveProducts: results.total,
      scanned,
      productsWithDetectedWeight: results.detected,
      productsWithoutDetectedWeight: results.noWeight,
      validForReview: results.valid,
      suspiciousForReview: results.suspicious,
      validExamples,
      suspiciousExamples,
    });
  }),
);

export const weightValidationRouter = router;