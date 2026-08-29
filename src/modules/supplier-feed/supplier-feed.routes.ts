import { Router } from 'express';
import { timingSafeEqual } from 'crypto';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { env } from '../../config/env';
import { asyncHandler } from '../../lib/async-handler';
import { HttpError } from '../../lib/http-error';
import { routeParam } from '../../lib/route-param';
import { recommendedRetailPrice } from '../../services/pricing.service';
import { processProductAlerts } from '../../services/product-alert.service';
import { setSupplierReportedStock } from '../../services/supplier-inventory.service';

export const supplierFeedRouter = Router();

function validSecret(value?: string) {
  if (!env.SUPPLIER_FEED_SECRET || !value) return false;
  const expected = Buffer.from(env.SUPPLIER_FEED_SECRET);
  const actual = Buffer.from(value);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

supplierFeedRouter.post('/:code', asyncHandler(async (req, res) => {
  const authorization = req.header('authorization');
  const secret = authorization?.startsWith('Bearer ') ? authorization.slice(7) : req.header('x-sandman-supplier-secret');
  if (!validSecret(secret)) throw new HttpError(401, 'Invalid supplier feed secret');
  const code = routeParam(req.params.code, 'code').trim().toLowerCase();
  const supplier = await prisma.supplier.findUnique({ where: { code } });
  if (!supplier || !supplier.active) throw new HttpError(404, 'Supplier not found');

  const body = z.object({ items: z.array(z.object({
    productSku: z.string().min(1),
    supplierProductId: z.string().min(1),
    supplierSku: z.string().optional(),
    costCents: z.number().int().nonnegative(),
    shippingCents: z.number().int().nonnegative().default(0),
    stock: z.number().int().nonnegative().nullable().optional(),
    currency: z.string().length(3).default('USD'),
  })).min(1).max(5000) }).parse(req.body);

  const run = await prisma.supplierSyncRun.create({ data: { supplierId: supplier.id, status: 'RUNNING', productsSeen: body.items.length } });
  let updated = 0;
  let stockUpdates = 0;
  let repriced = 0;
  try {
    for (const row of body.items) {
      const product = await prisma.product.findUnique({ where: { sku: row.productSku } });
      if (!product) continue;
      const previous = await prisma.supplierProduct.findUnique({ where: { supplierId_supplierProductId: { supplierId: supplier.id, supplierProductId: row.supplierProductId } } });
      const previousAvailableStock = previous?.availableStock ?? null;
      const newAvailableStock = await prisma.$transaction(async tx => {
        const link = await tx.supplierProduct.upsert({
          where: { supplierId_supplierProductId: { supplierId: supplier.id, supplierProductId: row.supplierProductId } },
          update: { supplierSku: row.supplierSku, costCents: row.costCents, shippingCents: row.shippingCents, currency: row.currency.toUpperCase(), active: true },
          create: { supplierId: supplier.id, productId: product.id, supplierProductId: row.supplierProductId, supplierSku: row.supplierSku, costCents: row.costCents, shippingCents: row.shippingCents, stock: row.stock ?? null, availableStock: row.stock ?? null, currency: row.currency.toUpperCase(), active: true, lastSyncedAt: new Date() },
        });
        return setSupplierReportedStock(tx, link.id, row.stock ?? null);
      });
      updated += 1;
      if (previousAvailableStock !== newAvailableStock) {
        stockUpdates += 1;
        await processProductAlerts({ productId: product.id, previousStock: previousAvailableStock, newStock: newAvailableStock }).catch(() => undefined);
      }
      if (env.AUTO_PRICE_SUPPLIER_FEEDS && product.sourceType === 'DROPSHIP') {
        const newPrice = await recommendedRetailPrice({ supplierId: supplier.id, categoryId: product.categoryId, costCents: row.costCents, shippingCents: row.shippingCents });
        if (newPrice > 0 && newPrice !== product.priceCents) {
          await prisma.product.update({ where: { id: product.id }, data: { priceCents: newPrice } });
          await processProductAlerts({ productId: product.id, previousPriceCents: product.priceCents, newPriceCents: newPrice }).catch(() => undefined);
          repriced += 1;
        }
      }
    }
    await prisma.supplierSyncRun.update({ where: { id: run.id }, data: { status: 'SUCCEEDED', productsUpdated: updated, stockUpdates, finishedAt: new Date() } });
    res.json({ success: true, runId: run.id, productsSeen: body.items.length, updated, stockUpdates, repriced });
  } catch (error) {
    await prisma.supplierSyncRun.update({ where: { id: run.id }, data: { status: 'FAILED', errorMessage: error instanceof Error ? error.message.slice(0, 1000) : 'Unknown sync error', finishedAt: new Date() } });
    throw error;
  }
}));
