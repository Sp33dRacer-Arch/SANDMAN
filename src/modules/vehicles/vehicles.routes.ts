import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { asyncHandler } from '../../lib/async-handler';
import { HttpError } from '../../lib/http-error';
import { routeParam } from '../../lib/route-param';

export const vehiclesRouter = Router();

vehiclesRouter.get('/makes', asyncHandler(async (_req, res) => {
  const makes = await prisma.vehicleMake.findMany({ orderBy: { name: 'asc' } });
  res.json(makes);
}));

vehiclesRouter.get('/models', asyncHandler(async (req, res) => {
  const { makeId } = z.object({ makeId: z.string().min(1) }).parse(req.query);
  const models = await prisma.vehicleModel.findMany({ where: { makeId }, orderBy: { name: 'asc' } });
  res.json(models);
}));

vehiclesRouter.get('/variants', asyncHandler(async (req, res) => {
  const query = z.object({
    modelId: z.string().min(1),
    year: z.coerce.number().int().min(1900).max(2200).optional(),
    engineCode: z.string().optional(),
  }).parse(req.query);

  const variants = await prisma.vehicleVariant.findMany({
    where: {
      modelId: query.modelId,
      ...(query.year ? { yearStart: { lte: query.year }, yearEnd: { gte: query.year } } : {}),
      ...(query.engineCode ? { engineCode: { equals: query.engineCode, mode: 'insensitive' } } : {}),
    },
    include: { model: { include: { make: true } } },
    orderBy: [{ yearStart: 'desc' }, { engineCode: 'asc' }],
  });
  res.json(variants);
}));

vehiclesRouter.get('/variants/:id', asyncHandler(async (req, res) => {
  const variant = await prisma.vehicleVariant.findUnique({
    where: { id: routeParam(req.params.id, 'id') },
    include: { model: { include: { make: true } } },
  });
  if (!variant) throw new HttpError(404, 'Vehicle variant not found');
  res.json(variant);
}));

vehiclesRouter.get('/search', asyncHandler(async (req, res) => {
  const { q } = z.object({ q: z.string().trim().min(2).max(100) }).parse(req.query);
  const tokens = q.split(/\s+/).filter(Boolean).slice(0, 8);
  const and: Prisma.VehicleVariantWhereInput[] = tokens.map(token => {
    const year = /^\d{4}$/.test(token) ? Number(token) : null;
    if (year && year >= 1900 && year <= 2200) {
      return { yearStart: { lte: year }, yearEnd: { gte: year } };
    }
    return {
      OR: [
        { engineCode: { contains: token, mode: 'insensitive' } },
        { engineName: { contains: token, mode: 'insensitive' } },
        { chassisCode: { contains: token, mode: 'insensitive' } },
        { trim: { contains: token, mode: 'insensitive' } },
        { model: { name: { contains: token, mode: 'insensitive' } } },
        { model: { make: { name: { contains: token, mode: 'insensitive' } } } },
      ],
    };
  });

  const variants = await prisma.vehicleVariant.findMany({
    where: { AND: and },
    include: { model: { include: { make: true } } },
    orderBy: [{ yearStart: 'desc' }, { engineCode: 'asc' }],
    take: 40,
  });
  res.json(variants);
}));
