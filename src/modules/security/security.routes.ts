import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { asyncHandler } from '../../lib/async-handler';
import { HttpError } from '../../lib/http-error';
import { routeParam } from '../../lib/route-param';
import { requireAuth } from '../../middleware/auth';
import { createTotpSecret, decryptTotpSecret, encryptTotpSecret, verifyTotp } from '../../services/totp.service';

export const securityRouter = Router();
securityRouter.use(requireAuth);

securityRouter.get('/sessions', asyncHandler(async (req, res) => {
  const sessions = await prisma.authSession.findMany({
    where: { userId: req.auth!.userId, revokedAt: null, expiresAt: { gt: new Date() } },
    select: { id: true, createdAt: true, lastUsedAt: true, expiresAt: true, userAgent: true, ipAddress: true },
    orderBy: { lastUsedAt: 'desc' },
  });
  res.json(sessions.map(s => ({ ...s, current: s.id === req.auth!.sessionId })));
}));

securityRouter.delete('/sessions/:id', asyncHandler(async (req, res) => {
  const result = await prisma.authSession.updateMany({
    where: { id: routeParam(req.params.id, 'id'), userId: req.auth!.userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (!result.count) throw new HttpError(404, 'Session not found');
  res.status(204).send();
}));

securityRouter.post('/sessions/revoke-others', asyncHandler(async (req, res) => {
  await prisma.authSession.updateMany({
    where: { userId: req.auth!.userId, id: { not: req.auth!.sessionId }, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  res.status(204).send();
}));

securityRouter.get('/2fa/status', asyncHandler(async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.auth!.userId }, select: { twoFactorEnabled: true } });
  res.json({ enabled: Boolean(user?.twoFactorEnabled) });
}));

securityRouter.post('/2fa/setup', asyncHandler(async (req, res) => {
  const { password } = z.object({ password: z.string().min(1) }).parse(req.body);
  const user = await prisma.user.findUnique({ where: { id: req.auth!.userId } });
  if (!user) throw new HttpError(404, 'User not found');
  if (!(await bcrypt.compare(password, user.passwordHash))) throw new HttpError(401, 'Password is incorrect');
  if (user.twoFactorEnabled) throw new HttpError(409, '2FA is already enabled. Disable it with your password and current authenticator code before setting up a new authenticator.');
  const secret = createTotpSecret();
  await prisma.user.update({ where: { id: user.id }, data: { twoFactorSecretEnc: encryptTotpSecret(secret), twoFactorEnabled: false } });
  const label = encodeURIComponent(`SANDMAN:${user.email}`);
  const issuer = encodeURIComponent('SANDMAN');
  res.json({ secret, otpauthUrl: `otpauth://totp/${label}?secret=${secret}&issuer=${issuer}&digits=6&period=30` });
}));

securityRouter.post('/2fa/enable', asyncHandler(async (req, res) => {
  const { code } = z.object({ code: z.string().regex(/^\d{6}$/) }).parse(req.body);
  const user = await prisma.user.findUnique({ where: { id: req.auth!.userId } });
  if (!user?.twoFactorSecretEnc) throw new HttpError(409, 'Start 2FA setup first');
  if (!verifyTotp(decryptTotpSecret(user.twoFactorSecretEnc), code)) throw new HttpError(400, 'Invalid authenticator code');
  await prisma.user.update({ where: { id: user.id }, data: { twoFactorEnabled: true } });
  res.json({ enabled: true });
}));

securityRouter.post('/2fa/disable', asyncHandler(async (req, res) => {
  const body = z.object({ password: z.string().min(1), code: z.string().regex(/^\d{6}$/) }).parse(req.body);
  const user = await prisma.user.findUnique({ where: { id: req.auth!.userId } });
  if (!user || !(await bcrypt.compare(body.password, user.passwordHash))) throw new HttpError(401, 'Password is incorrect');
  if (!user.twoFactorSecretEnc || !verifyTotp(decryptTotpSecret(user.twoFactorSecretEnc), body.code)) throw new HttpError(400, 'Invalid authenticator code');
  await prisma.user.update({ where: { id: user.id }, data: { twoFactorEnabled: false, twoFactorSecretEnc: null } });
  res.json({ enabled: false });
}));
