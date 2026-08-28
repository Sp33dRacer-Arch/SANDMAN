import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { asyncHandler } from '../../lib/async-handler';
import { HttpError } from '../../lib/http-error';
import { requireAuth } from '../../middleware/auth';

export const garageRouter = Router();
garageRouter.use(requireAuth);

garageRouter.get('/', asyncHandler(async (req, res) => {
  const vehicles = await prisma.garageVehicle.findMany({
    where: { userId: req.auth!.userId },
    include: { vehicleVariant: { include: { model: { include: { make: true } } } } },
    orderBy: [{ isPrimary: 'desc' }, { createdAt: 'desc' }],
  });
  res.json(vehicles);
}));

garageRouter.post('/', asyncHandler(async (req, res) => {
  const data = z.object({
    vehicleVariantId: z.string().min(1),
    year: z.number().int().min(1900).max(2200),
    nickname: z.string().max(80).optional(),
    vin: z.string().min(11).max(17).optional(),
    isPrimary: z.boolean().default(false),
  }).parse(req.body);

  const variant = await prisma.vehicleVariant.findUnique({ where: { id: data.vehicleVariantId } });
  if (!variant) throw new HttpError(404, 'Vehicle variant not found');
  if (data.year < variant.yearStart || data.year > variant.yearEnd) {
    throw new HttpError(400, 'Selected year does not match that engine/vehicle variant');
  }

  const vehicle = await prisma.$transaction(async tx => {
    if (data.isPrimary) await tx.garageVehicle.updateMany({ where: { userId: req.auth!.userId }, data: { isPrimary: false } });
    return tx.garageVehicle.create({
      data: { ...data, userId: req.auth!.userId },
      include: { vehicleVariant: { include: { model: { include: { make: true } } } } },
    });
  });
  res.status(201).json(vehicle);
}));

garageRouter.patch('/:id/primary', asyncHandler(async (req, res) => {
  const own = await prisma.garageVehicle.findFirst({ where: { id: req.params.id, userId: req.auth!.userId } });
  if (!own) throw new HttpError(404, 'Garage vehicle not found');
  await prisma.$transaction([
    prisma.garageVehicle.updateMany({ where: { userId: req.auth!.userId }, data: { isPrimary: false } }),
    prisma.garageVehicle.update({ where: { id: own.id }, data: { isPrimary: true } }),
  ]);
  res.json({ success: true });
}));

garageRouter.delete('/:id', asyncHandler(async (req, res) => {
  const result = await prisma.garageVehicle.deleteMany({ where: { id: req.params.id, userId: req.auth!.userId } });
  if (!result.count) throw new HttpError(404, 'Garage vehicle not found');
  res.status(204).send();
}));
