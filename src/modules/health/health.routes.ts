import { Router } from 'express';
import { prisma } from '../../lib/prisma';
import { asyncHandler } from '../../lib/async-handler';

export const healthRouter = Router();

healthRouter.get('/', asyncHandler(async (_req, res) => {
  await prisma.$queryRaw`SELECT 1`;
  res.json({ ok: true, service: 'SANDMAN API', timestamp: new Date().toISOString() });
}));
