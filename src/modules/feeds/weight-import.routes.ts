import { Router } from 'express';
import { prisma } from '../../lib/prisma';
import { asyncHandler } from '../../lib/async-handler';

const router = Router();

function extractWeight(text: string) {
  const regex =
    /(\d+(?:\.\d+)?)\s*[-]?\s*(kg|kilograms?|g|grams?|lb|lbs|pounds?)(?![a-z])/gi;

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

    if (grams <= 0 || grams > 100000) continue;

    weights.push(Math.round(grams));
  }

  return weights;
}

function isLikelyWeight(text: string, weights: number[]) {
  if (weights.length === 0) return false;

  /*
   * Ignore values that are very likely specifications rather
   * than weights when they use a bare "G" notation.
   */
  const hasRealWeightUnit =
    /\d+(?:\.\d+)?\s*(?:kg|kilograms?|grams?|lb|lbs|pounds?)(?![a-z])/i.test(
      text,
    );

  if (!hasRealWeightUnit) return false;

  /*
   * If multiple different weights occur in the description,
   * don't automatically choose one.
   */
  const uniqueWeights = [...new Set(weights)];

  if (uniqueWeights.length > 1) return false;

  const grams = uniqueWeights[0];

  if (grams === undefined) return false;

  /*
   * Allow everything from tiny components to very heavy
   * automotive equipment.
   */
  if (grams < 2) return false;
  if (grams > 100000) return false;

  return true;
}

router.post(
  '/import-product-weights',
  asyncHandler(async (_req, res) => {
    const BATCH_SIZE = 500;

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

        const weights = extractWeight(text);

        if (!isLikelyWeight(text, weights)) {
          skipped++;
          continue;
        }

        const weight = [...new Set(weights)][0];

        if (weight === undefined) {
          skipped++;
          continue;
        }

        await prisma.product.update({
          where: {
            id: product.id,
          },
          data: {
            weightGrams: weight,
          },
        });

        updated++;
      }

      const last = products[products.length - 1];

      if (!last) break;

      cursor = last.id;

      console.log(
        `Weight import: ${scanned.toLocaleString()} scanned, ` +
          `${updated.toLocaleString()} updated, ` +
          `${skipped.toLocaleString()} skipped`,
      );

      if (products.length < BATCH_SIZE) break;
    }

    res.json({
      success: true,
      scanned,
      updated,
      skipped,
      databaseModified: true,
    });
  }),
);

export const weightImportRouter = router;