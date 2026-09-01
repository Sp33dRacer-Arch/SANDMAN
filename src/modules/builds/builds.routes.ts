import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { asyncHandler } from '../../lib/async-handler';
import { HttpError } from '../../lib/http-error';
import { routeParam } from '../../lib/route-param';
import { optionalAuth, requireAuth } from '../../middleware/auth';
import { evaluateFitment } from '../../services/fitment.service';
import { publicProduct } from '../../lib/public-product';

export const buildsRouter = Router();

function buildWithItems() {
  return {
    garageVehicle: { include: { vehicleVariant: { include: { model: { include: { make: true } } } } } },
    vehicleVariant: { include: { model: { include: { make: true } } } },
    items: {
      include: {
        product: {
          include: {
            category: true,
            images: { orderBy: { position: 'asc' as const }, take: 1 },
            fitments: { select: { vehicleVariantId: true, verified: true, source: true, notes: true, verifiedAt: true } },
          },
        },
      },
      orderBy: { createdAt: 'asc' as const },
    },
  };
}

function summarize(build: any) {
  const variantId = build.garageVehicle?.vehicleVariantId ?? build.vehicleVariantId ?? null;
  const items = build.items.map((item: any) => {
    const p = item.product;
    const fitment = evaluateFitment(p, variantId);
    return { ...item, product: publicProduct(p), fitmentStatus: fitment.status, fitmentVerified: fitment.verified, fitmentReason: fitment.reason, lineTotalCents: p.priceCents * item.quantity };
  });
  const totalCents = items.reduce((sum: number, item: any) => sum + item.lineTotalCents, 0);
  const incompatible = items.filter((item: any) => item.fitmentStatus === 'DOES_NOT_FIT').length;
  const unconfirmed = items.filter((item: any) => item.fitmentStatus === 'UNKNOWN').length;
  return { ...build, items, totalCents, budgetRemainingCents: build.budgetCents == null ? null : build.budgetCents - totalCents, incompatible, unconfirmed };
}

buildsRouter.get('/public/:id', optionalAuth, asyncHandler(async (req, res) => {
  const build = await prisma.build.findFirst({ where: { id: routeParam(req.params.id, 'id'), isPublic: true }, include: buildWithItems() });
  if (!build) throw new HttpError(404, 'Build not found');
  res.json(summarize(build));
}));

buildsRouter.use(requireAuth);

buildsRouter.get('/', asyncHandler(async (req, res) => {
  const builds = await prisma.build.findMany({
    where: { userId: req.auth!.userId },
    include: { garageVehicle: { include: { vehicleVariant: { include: { model: { include: { make: true } } } } } }, _count: { select: { items: true } } },
    orderBy: { updatedAt: 'desc' },
  });
  res.json(builds);
}));

buildsRouter.post('/', asyncHandler(async (req, res) => {
  const body = z.object({
    name: z.string().trim().min(2).max(120),
    garageVehicleId: z.string().optional(),
    vehicleVariantId: z.string().optional(),
    targetPowerHp: z.number().int().min(50).max(5000).optional(),
    targetTorqueNm: z.number().int().min(50).max(10_000).optional(),
    budgetCents: z.number().int().positive().max(100_000_000).optional(),
    goal: z.string().trim().max(120).optional(),
    notes: z.string().max(2000).optional(),
    isPublic: z.boolean().default(false),
  }).refine(v => !(v.garageVehicleId && v.vehicleVariantId), { message: 'Choose a garage vehicle or a vehicle variant, not both' }).parse(req.body);

  if (body.garageVehicleId) {
    const garage = await prisma.garageVehicle.findFirst({ where: { id: body.garageVehicleId, userId: req.auth!.userId } });
    if (!garage) throw new HttpError(404, 'Garage vehicle not found');
  }
  if (body.vehicleVariantId && !(await prisma.vehicleVariant.findUnique({ where: { id: body.vehicleVariantId } }))) throw new HttpError(404, 'Vehicle variant not found');

  const build = await prisma.build.create({ data: { ...body, userId: req.auth!.userId }, include: buildWithItems() });
  res.status(201).json(summarize(build));
}));

buildsRouter.get('/:id', asyncHandler(async (req, res) => {
  const build = await prisma.build.findFirst({ where: { id: routeParam(req.params.id, 'id'), userId: req.auth!.userId }, include: buildWithItems() });
  if (!build) throw new HttpError(404, 'Build not found');
  res.json(summarize(build));
}));

buildsRouter.patch('/:id', asyncHandler(async (req, res) => {
  const id = routeParam(req.params.id, 'id');
  const existing = await prisma.build.findFirst({ where: { id, userId: req.auth!.userId } });
  if (!existing) throw new HttpError(404, 'Build not found');
  const body = z.object({
    name: z.string().trim().min(2).max(120).optional(),
    targetPowerHp: z.number().int().min(50).max(5000).nullable().optional(),
    targetTorqueNm: z.number().int().min(50).max(10_000).nullable().optional(),
    budgetCents: z.number().int().positive().max(100_000_000).nullable().optional(),
    goal: z.string().trim().max(120).nullable().optional(),
    notes: z.string().max(2000).nullable().optional(),
    isPublic: z.boolean().optional(),
  }).parse(req.body);
  const build = await prisma.build.update({ where: { id }, data: body, include: buildWithItems() });
  res.json(summarize(build));
}));

buildsRouter.delete('/:id', asyncHandler(async (req, res) => {
  const deleted = await prisma.build.deleteMany({ where: { id: routeParam(req.params.id, 'id'), userId: req.auth!.userId } });
  if (!deleted.count) throw new HttpError(404, 'Build not found');
  res.status(204).send();
}));

buildsRouter.post('/:id/items', asyncHandler(async (req, res) => {
  const id = routeParam(req.params.id, 'id');
  const body = z.object({ productId: z.string().min(1), quantity: z.number().int().min(1).max(20).default(1), notes: z.string().max(500).optional() }).parse(req.body);
  const [build, product] = await Promise.all([
    prisma.build.findFirst({ where: { id, userId: req.auth!.userId } }),
    prisma.product.findFirst({ where: { id: body.productId, status: 'ACTIVE' } }),
  ]);
  if (!build) throw new HttpError(404, 'Build not found');
  if (!product) throw new HttpError(404, 'Product not found');
  const item = await prisma.buildItem.upsert({
    where: { buildId_productId: { buildId: id, productId: body.productId } },
    update: { quantity: body.quantity, notes: body.notes },
    create: { buildId: id, ...body },
  });
  res.status(201).json(item);
}));

buildsRouter.patch('/:id/items/:itemId', asyncHandler(async (req, res) => {
  const build = await prisma.build.findFirst({ where: { id: routeParam(req.params.id, 'id'), userId: req.auth!.userId } });
  if (!build) throw new HttpError(404, 'Build not found');
  const body = z.object({ quantity: z.number().int().min(1).max(20).optional(), notes: z.string().max(500).nullable().optional() }).parse(req.body);
  const item = await prisma.buildItem.updateMany({ where: { id: routeParam(req.params.itemId, 'itemId'), buildId: build.id }, data: body });
  if (!item.count) throw new HttpError(404, 'Build item not found');
  res.status(204).send();
}));

buildsRouter.delete('/:id/items/:itemId', asyncHandler(async (req, res) => {
  const build = await prisma.build.findFirst({ where: { id: routeParam(req.params.id, 'id'), userId: req.auth!.userId } });
  if (!build) throw new HttpError(404, 'Build not found');
  await prisma.buildItem.deleteMany({ where: { id: routeParam(req.params.itemId, 'itemId'), buildId: build.id } });
  res.status(204).send();
}));
