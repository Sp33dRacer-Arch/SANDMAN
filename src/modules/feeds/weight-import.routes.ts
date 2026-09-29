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

router.get(
  '/find-product-weights',
  asyncHandler(async (req, res) => {
    const BATCH_SIZE = 1000;
    const MAX_SCANNED = 20000;
    const TARGET_MATCHES = 20;

    let cursor =
      typeof req.query.afterId === 'string'
        ? req.query.afterId
        : undefined;

    let scanned = 0;

    const matches: Array<{
      id: string;
      sku: string;
      name: string;
      detected: string;
      grams: number;
      source: string;
    }> = [];

    while (
      scanned < MAX_SCANNED &&
      matches.length < TARGET_MATCHES
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
          specs: true,
        },

        orderBy: {
          id: 'asc',
        },

        take: BATCH_SIZE,
      });

      if (products.length === 0) {
        break;
      }

      for (const product of products) {
        scanned++;

        const found: WeightMatch[] = [];

        found.push(
          ...extractWeights(
            product.name,
            'name',
          ),
        );

        found.push(
          ...extractWeights(
            product.description || '',
            'description',
          ),
        );

        if (product.specs) {
          const specsText =
            JSON.stringify(product.specs);

          found.push(
            ...extractWeights(
              specsText,
              'specs',
            ),
          );
        }

        const first = found[0];

        if (first) {
          matches.push({
            id: product.id,
            sku: product.sku,
            name: product.name,
            detected: first.raw,
            grams: first.grams,
            source: first.source,
          });

          if (matches.length >= TARGET_MATCHES) {
            break;
          }
        }
      }

      const last =
        products[products.length - 1];

      if (!last) {
        break;
      }

      cursor = last.id;

      if (products.length < BATCH_SIZE) {
        break;
      }
    }

    res.json({
      success: true,
      readOnly: true,
      databaseModified: false,

      scanned,

      matchesFound: matches.length,

      nextAfterId: cursor ?? null,

      matches,

      message:
        matches.length > 0
          ? 'Found products containing weight-like values.'
          : 'No weight-like values found within the scan range.',
    });
  }),
);

export const weightImportRouter = router;