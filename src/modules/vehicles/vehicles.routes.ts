import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { asyncHandler } from '../../lib/async-handler';
import { HttpError } from '../../lib/http-error';

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
    where: { id: req.params.id },
    include: { model: { include: { make: true } } },
  });
  if (!variant) throw new HttpError(404, 'Vehicle variant not found');
  res.json(variant);
}));

vehiclesRouter.get('/search', asyncHandler(async (req, res) => {
  const { q } = z.object({ q: z.string().min(2).max(80) }).parse(req.query);
  const variants = await prisma.vehicleVariant.findMany({
    where: {
      OR: [
        { engineCode: { contains: q, mode: 'insensitive' } },
        { engineName: { contains: q, mode: 'insensitive' } },
        { chassisCode: { contains: q, mode: 'insensitive' } },
        { model: { name: { contains: q, mode: 'insensitive' } } },
        { model: { make: { name: { contains: q, mode: 'insensitive' } } } },
      ],
    },
    include: { model: { include: { make: true } } },
    take: 30,
  });
  res.json(variants);
}));
