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

function flattenSpecs(
  value: unknown,
  path = 'specs',
): Array<{
  path: string;
  value: string;
}> {
  const output: Array<{
    path: string;
    value: string;
  }> = [];

  if (value === null || value === undefined) {
    return output;
  }

  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    output.push({
      path,
      value: String(value),
    });

    return output;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      output.push(
        ...flattenSpecs(item, `${path}[${index}]`),
      );
    });

    return output;
  }

  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(
      value as Record<string, unknown>,
    )) {
      output.push(
        ...flattenSpecs(child, `${path}.${key}`),
      );
    }
  }

  return output;
}

router.post(
  '/import-product-weights',
  asyncHandler(async (req, res) => {
    const DEFAULT_BATCH_SIZE = 1000;
    const MAX_BATCH_SIZE = 1000;

    const rawLimit = Number(req.query.limit);

    const BATCH_SIZE =
      Number.isFinite(rawLimit) && rawLimit > 0
        ? Math.min(
            Math.floor(rawLimit),
            MAX_BATCH_SIZE,
          )
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
        specs: true,
        weightGrams: true,
      },

      orderBy: {
        id: 'asc',
      },

      take: BATCH_SIZE,
    });

    let valid = 0;
    let updated = 0;
    let skipped = 0;

    const sourceCounts = {
      name: 0,
      description: 0,
      specs: 0,
    };

    const validExamples: Array<{
      sku: string;
      name: string;
      detected: string;
      grams: number;
      source: string;
    }> = [];

    const specsExamples: Array<{
      sku: string;
      name: string;
      path: string;
      value: string;
    }> = [];

    const noWeightExamples: Array<{
      sku: string;
      name: string;
      specsKeys: string[];
    }> = [];

    for (const product of products) {
      const matches: WeightMatch[] = [];

      matches.push(
        ...extractWeights(
          product.name,
          'name',
        ),
      );

      matches.push(
        ...extractWeights(
          product.description || '',
          'description',
        ),
      );

      const flattenedSpecs =
        flattenSpecs(product.specs);

      for (const item of flattenedSpecs) {
        const specMatches = extractWeights(
          item.value,
          'specs',
        );

        matches.push(...specMatches);

        if (
          diagnostic &&
          specMatches.length > 0 &&
          specsExamples.length < 30
        ) {
          specsExamples.push({
            sku: product.sku,
            name: product.name,
            path: item.path,
            value: item.value,
          });
        }
      }

      const uniqueWeights = [
        ...new Map(
          matches.map((match) => [
            `${match.grams}`,
            match,
          ]),
        ).values(),
      ];

      if (uniqueWeights.length === 0) {
        skipped++;

        if (
          diagnostic &&
          noWeightExamples.length < 30
        ) {
          const specsKeys =
            product.specs &&
            typeof product.specs === 'object' &&
            !Array.isArray(product.specs)
              ? Object.keys(
                  product.specs as Record<
                    string,
                    unknown
                  >,
                )
              : [];

          noWeightExamples.push({
            sku: product.sku,
            name: product.name,
            specsKeys,
          });
        }

        continue;
      }

      if (uniqueWeights.length > 1) {
        skipped++;
        continue;
      }

      const selected = uniqueWeights[0];

      if (!selected) {
        skipped++;
        continue;
      }

      valid++;

      sourceCounts[selected.source]++;

      if (validExamples.length < 30) {
        validExamples.push({
          sku: product.sku,
          name: product.name,
          detected: selected.raw,
          grams: selected.grams,
          source: selected.source,
        });
      }

      if (!dryRun) {
        await prisma.product.update({
          where: {
            id: product.id,
          },
          data: {
            weightGrams: selected.grams,
          },
        });

        updated++;
      }
    }

    const lastProduct = products.at(-1);

    const remaining =
      await prisma.product.count({
        where: {
          status: 'ACTIVE',
          weightGrams: null,
        },
      });

    res.json({
      success: true,

      dryRun,
      diagnostic,

      databaseModified:
        !dryRun && updated > 0,

      scanned: products.length,

      valid,
      updated,
      skipped,

      detectedSources: sourceCounts,

      lastId:
        lastProduct?.id ?? null,

      remainingProductsWithoutWeight:
        remaining,

      examples: {
        valid: validExamples,

        ...(diagnostic
          ? {
              specsMatches: specsExamples,
              noWeight: noWeightExamples,
            }
          : {}),
      },

      message: dryRun
        ? 'Dry run completed. No database changes were made.'
        : 'Batch completed.',
    });
  }),
);

export const weightImportRouter = router;