import { Router } from 'express';
import { createHash, randomBytes } from 'crypto';
import { z } from 'zod';
import { rateLimit } from 'express-rate-limit';
import { env } from '../../config/env';
import { requireAuth } from '../../middleware/auth';
import { asyncHandler } from '../../lib/async-handler';
import { HttpError } from '../../lib/http-error';
import { prisma } from '../../lib/prisma';

export const uploadsRouter = Router();
uploadsRouter.use(rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false }));

const purposeSchema = z.object({
  purpose: z.enum(['catalogue', 'marketplace', 'reviews', 'returns', 'profile', 'posts', 'dealer']).default('marketplace'),
});

uploadsRouter.get('/status', requireAuth, asyncHandler(async (_req, res) => {
  res.json({ configured: Boolean(env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET) });
}));

uploadsRouter.post('/signature', requireAuth, asyncHandler(async (req, res) => {
  const { purpose } = purposeSchema.parse(req.body);
  const account = await prisma.user.findUnique({ where: { id: req.auth!.userId }, select: { emailVerifiedAt: true } });
  if (!account?.emailVerifiedAt) throw new HttpError(403, 'Verify your email before uploading images');
  if (!env.CLOUDINARY_CLOUD_NAME || !env.CLOUDINARY_API_KEY || !env.CLOUDINARY_API_SECRET) {
    throw new HttpError(503, 'Image-file uploads are not configured yet. You can still add image URLs.');
  }
  if (purpose === 'catalogue' && !['ADMIN', 'STAFF'].includes(req.auth!.role)) {
    throw new HttpError(403, 'Admin access is required for catalogue uploads');
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const folder = purpose === 'catalogue' ? 'sandman/catalogue'
    : purpose === 'reviews' ? `sandman/reviews/${req.auth!.userId}`
    : purpose === 'returns' ? `sandman/returns/${req.auth!.userId}`
    : purpose === 'profile' ? `sandman/profiles/${req.auth!.userId}`
    : purpose === 'posts' ? `sandman/posts/${req.auth!.userId}`
    : purpose === 'dealer' ? `sandman/dealer-verification/${req.auth!.userId}`
    : `sandman/marketplace/${req.auth!.userId}`;
  const publicId = `image-${Date.now()}-${randomBytes(6).toString('hex')}`;
  const stringToSign = `folder=${folder}&public_id=${publicId}&timestamp=${timestamp}${env.CLOUDINARY_API_SECRET}`;
  const signature = createHash('sha1').update(stringToSign).digest('hex');

  res.json({
    cloudName: env.CLOUDINARY_CLOUD_NAME,
    apiKey: env.CLOUDINARY_API_KEY,
    timestamp,
    folder,
    publicId,
    signature,
    maxFiles: 8,
    maxBytes: 10 * 1024 * 1024,
    accepted: ['image/jpeg', 'image/png', 'image/webp'],
  });
}));
