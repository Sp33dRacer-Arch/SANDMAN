import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { asyncHandler } from '../../lib/async-handler';
import { optionalAuth } from '../../middleware/auth';

export const privacyRouter = Router();

const anonymousIdSchema = z.string().trim().min(12).max(120).regex(/^[A-Za-z0-9_.:-]+$/);

privacyRouter.post('/consent', optionalAuth, asyncHandler(async (req, res) => {
  const data = z.object({
    anonymousId: anonymousIdSchema,
    analytics: z.boolean().default(false),
    marketing: z.boolean().default(false),
    preferences: z.boolean().default(false),
    policyVersion: z.string().trim().min(1).max(40).default('2026-09-v2.5'),
  }).parse(req.body);
  const record = await prisma.privacyConsent.upsert({
    where: { anonymousId: data.anonymousId },
    update: {
      userId: req.auth?.userId,
      necessary: true,
      analytics: data.analytics,
      marketing: data.marketing,
      preferences: data.preferences,
      policyVersion: data.policyVersion,
      consentedAt: new Date(),
    },
    create: {
      anonymousId: data.anonymousId,
      userId: req.auth?.userId,
      necessary: true,
      analytics: data.analytics,
      marketing: data.marketing,
      preferences: data.preferences,
      policyVersion: data.policyVersion,
    },
  });
  res.json({
    necessary: record.necessary,
    analytics: record.analytics,
    marketing: record.marketing,
    preferences: record.preferences,
    policyVersion: record.policyVersion,
    consentedAt: record.consentedAt,
  });
}));

privacyRouter.post('/consent/withdraw', optionalAuth, asyncHandler(async (req, res) => {
  const { anonymousId } = z.object({ anonymousId: anonymousIdSchema }).parse(req.body);
  const record = await prisma.privacyConsent.upsert({
    where: { anonymousId },
    update: { userId: req.auth?.userId, necessary: true, analytics: false, marketing: false, preferences: false, consentedAt: new Date() },
    create: { anonymousId, userId: req.auth?.userId, necessary: true, analytics: false, marketing: false, preferences: false },
  });
  res.json({ necessary: true, analytics: false, marketing: false, preferences: false, consentedAt: record.consentedAt });
}));
