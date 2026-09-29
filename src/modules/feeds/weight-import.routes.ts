import { Router } from 'express';
import { prisma } from '../../lib/prisma';
import { asyncHandler } from '../../lib/async-handler';

const router = Router();

type WeightMatch = {
  raw: string;
  grams: number;
};

type DiagnosticReason =
  | 'valid'
  | 'no_weight'
  | 'multiple_weights';

function extractWeights(text: string): WeightMatch[] {
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

function getUniqueWeights(matches: WeightMatch[]): WeightMatch[] {
  const unique = new Map<number, WeightMatch>();

  for (const match of matches) {
    if (!unique.has(match.grams)) {
      unique.set(match.grams, match);
    }
  }

  return [...unique.values()];
}

function getDiagnosticReason(
  matches: WeightMatch[],
): DiagnosticReason {
  const uniqueWeights = getUniqueWeights(matches);

  if (uniqueWeights.length === 0) {
    return 'no_weight';
  }

  if (uniqueWeights.length > 1) {
    return 'multiple_weights';
  }

  return 'valid';
}

router.post(
  '/import-product-weights',
  asyncHandler(async (req, res) => {
    const DEFAULT_BATCH_SIZE = 1000;
    const MAX_BATCH_SIZE = 1000;

    const rawLimit = Number(req.query.limit);

    const BATCH_SIZE =
      Number.isFinite(rawLimit) && rawLimit > 0
        ? Math.min(Math.floor(rawLimit), MAX_BATCH_SIZE)
        : DEFAULT_BATCH_SIZE;

    const afterId =
      typeof req.query.afterId === 'string'
        ? req.query.afterId
        : undefined;

    const dryRun =
      req.query.dryRun === 'true' ||
      req.query.dryRun === '1';

    const diagnostic =
      req.query.diagnostic === 'true' ||
      req.query.diagnostic === '1';

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
        weightGrams: true,
      },
      orderBy: {
        id: 'asc',
      },
      take: BATCH_SIZE,
    });

    let updated = 0;
    let skipped = 0;
    let valid = 0;
    let noWeight = 0;
    let multipleWeights = 0;

    const validExamples: Array<{
      id: string;
      sku: string;
      name: string;
      detected: string;
      grams: number;
    }> = [];

    const noWeightExamples: Array<{
      id: string;
      sku: string;
      name: string;
    }> = [];

    const multipleWeightExamples: Array<{
      id: string;
      sku: string;
      name: string;
      detected: string[];
      grams: number[];
    }> = [];

    for (const product of products) {
      const text =
        `${product.name}\n${product.description || ''}`;

      const matches = extractWeights(text);
      const uniqueWeights = getUniqueWeights(matches);
      const reason = getDiagnosticReason(matches);

      if (reason === 'no_weight') {
        noWeight++;
        skipped++;

        if (diagnostic && noWeightExamples.length < 20) {
          noWeightExamples.push({
            id: product.id,
            sku: product.sku,
            name: product.name,
          });
        }

        continue;
      }

      if (reason === 'multiple_weights') {
        multipleWeights++;
        skipped++;

        if (
          diagnostic &&
          multipleWeightExamples.length < 20
        ) {
          multipleWeightExamples.push({
            id: product.id,
            sku: product.sku,
            name: product.name,
            detected: matches.map((match) => match.raw),
            grams: matches.map((match) => match.grams),
          });
        }

        continue;
      }

      const selectedWeight = uniqueWeights[0];

      if (!selectedWeight) {
        skipped++;
        continue;
      }

      valid++;

      if (validExamples.length < 20) {
        validExamples.push({
          id: product.id,
          sku: product.sku,
          name: product.name,
          detected: selectedWeight.raw,
          grams: selectedWeight.grams,
        });
      }

      if (!dryRun) {
        await prisma.product.update({
          where: {
            id: product.id,
          },
          data: {
            weightGrams: selectedWeight.grams,
          },
        });

        updated++;
      }
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

      dryRun,
      diagnostic,

      databaseModified: !dryRun && updated > 0,

      scanned: products.length,

      valid,
      updated,
      skipped,

      skipReasons: {
        noWeight,
        multipleWeights,
      },

      lastId: lastProduct?.id ?? null,

      remainingAfterThisBatch: remaining,

      examples: {
        valid: validExamples,

        ...(diagnostic
          ? {
              noWeight: noWeightExamples,
              multipleWeights: multipleWeightExamples,
            }
          : {}),
      },

      message:
        products.length === 0
          ? 'No more products in this range.'
          : dryRun
            ? 'Dry run completed. No database changes were made.'
            : 'Batch completed. Run again using lastId.',
    });
  }),
);

export const weightImportRouter = router;