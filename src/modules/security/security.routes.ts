import { Router } from 'express';
import bcrypt from 'bcryptjs';
import QRCode from 'qrcode';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { asyncHandler } from '../../lib/async-handler';
import { HttpError } from '../../lib/http-error';
import { routeParam } from '../../lib/route-param';
import { requireAuth } from '../../middleware/auth';
import { createTotpSecret, decryptTotpSecret, encryptTotpSecret, verifyTotp } from '../../services/totp.service';
import { generateRecoveryCodes, recoveryHashes, verifySecondFactor } from '../../services/two-factor.service';
import { audit } from '../../services/audit.service';

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

securityRouter.get('/events', asyncHandler(async (req,res)=>{
  const rows=await prisma.securityEvent.findMany({where:{userId:req.auth!.userId},orderBy:{createdAt:'desc'},take:50});
  res.json(rows);
}));

securityRouter.delete('/sessions/:id', asyncHandler(async (req, res) => {
  const result = await prisma.authSession.updateMany({
    where: { id: routeParam(req.params.id, 'id'), userId: req.auth!.userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (!result.count) throw new HttpError(404, 'Session not found');
  await audit({actorUserId:req.auth!.userId,action:'SESSION_REVOKED',targetType:'AUTH_SESSION',targetId:routeParam(req.params.id,'id')});
  res.status(204).send();
}));

securityRouter.post('/sessions/revoke-others', asyncHandler(async (req, res) => {
  await prisma.authSession.updateMany({
    where: { userId: req.auth!.userId, id: { not: req.auth!.sessionId }, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  await audit({actorUserId:req.auth!.userId,action:'OTHER_SESSIONS_REVOKED',targetType:'USER',targetId:req.auth!.userId});
  res.status(204).send();
}));

securityRouter.get('/2fa/status', asyncHandler(async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.auth!.userId }, select: { twoFactorEnabled: true, twoFactorEnabledAt:true, twoFactorRecoveryCodeHashes:true } });
  const hashes=Array.isArray(user?.twoFactorRecoveryCodeHashes)?user!.twoFactorRecoveryCodeHashes:[];
  res.json({ enabled: Boolean(user?.twoFactorEnabled), enabledAt:user?.twoFactorEnabledAt ?? null, recoveryCodesRemaining:hashes.length });
}));

securityRouter.post('/2fa/setup', asyncHandler(async (req, res) => {
  const { password } = z.object({ password: z.string().min(1) }).parse(req.body);
  const user = await prisma.user.findUnique({ where: { id: req.auth!.userId } });
  if (!user) throw new HttpError(404, 'User not found');
  if (!(await bcrypt.compare(password, user.passwordHash))) throw new HttpError(401, 'Password is incorrect');
  if (user.twoFactorEnabled) throw new HttpError(409, '2FA is already enabled');
  const secret = createTotpSecret();
  const label = encodeURIComponent(`SANDMAN:${user.email}`);
  const issuer = encodeURIComponent('SANDMAN');
  const otpauthUrl = `otpauth://totp/${label}?secret=${secret}&issuer=${issuer}&digits=6&period=30`;
  // Important: pending secret is not the live second factor until the first code succeeds.
  await prisma.user.update({ where: { id: user.id }, data: { twoFactorPendingSecretEnc: encryptTotpSecret(secret), twoFactorSecretEnc:null, twoFactorRecoveryCodeHashes:[] } });
  const qrDataUrl = await QRCode.toDataURL(otpauthUrl, { errorCorrectionLevel:'M', margin:2, width:280 });
  res.json({ qrDataUrl, manualKey: secret });
}));

securityRouter.post('/2fa/enable', asyncHandler(async (req, res) => {
  const { code } = z.object({ code: z.string().regex(/^\d{6}$/) }).parse(req.body);
  const user = await prisma.user.findUnique({ where: { id: req.auth!.userId } });
  if (!user?.twoFactorPendingSecretEnc) throw new HttpError(409, 'Start 2FA setup first');
  const secret=decryptTotpSecret(user.twoFactorPendingSecretEnc);
  if (!verifyTotp(secret, code)) throw new HttpError(400, 'Invalid authenticator code');
  const recoveryCodes=generateRecoveryCodes();
  await prisma.user.update({ where: { id: user.id }, data: { twoFactorEnabled: true, twoFactorSecretEnc:user.twoFactorPendingSecretEnc, twoFactorPendingSecretEnc:null, twoFactorEnabledAt:new Date(), twoFactorRecoveryCodeHashes:recoveryHashes(recoveryCodes) } });
  await prisma.securityEvent.create({data:{userId:user.id,type:'TWO_FACTOR_ENABLED'}});
  await audit({actorUserId:user.id,action:'TWO_FACTOR_ENABLED',targetType:'USER',targetId:user.id});
  res.json({ enabled: true, recoveryCodes });
}));

securityRouter.post('/2fa/recovery-codes/regenerate', asyncHandler(async (req,res)=>{
  const body=z.object({password:z.string().min(1),code:z.string().min(6).max(32)}).parse(req.body);
  const user=await prisma.user.findUnique({where:{id:req.auth!.userId}});
  if(!user||!(await bcrypt.compare(body.password,user.passwordHash))) throw new HttpError(401,'Password is incorrect');
  if(!user.twoFactorEnabled||!user.twoFactorSecretEnc) throw new HttpError(409,'2FA is not enabled');
  const verified=await verifySecondFactor({userId:user.id,secretEnc:user.twoFactorSecretEnc,code:body.code});
  if(!verified.ok) throw new HttpError(400,'Invalid authenticator or recovery code');
  const codes=generateRecoveryCodes();
  await prisma.user.update({where:{id:user.id},data:{twoFactorRecoveryCodeHashes:recoveryHashes(codes)}});
  await audit({actorUserId:user.id,action:'RECOVERY_CODES_REGENERATED',targetType:'USER',targetId:user.id});
  res.json({recoveryCodes:codes});
}));

securityRouter.post('/2fa/disable', asyncHandler(async (req, res) => {
  const body = z.object({ password: z.string().min(1), code: z.string().min(6).max(32) }).parse(req.body);
  const user = await prisma.user.findUnique({ where: { id: req.auth!.userId } });
  if (!user || !(await bcrypt.compare(body.password, user.passwordHash))) throw new HttpError(401, 'Password is incorrect');
  if (!user.twoFactorSecretEnc) throw new HttpError(409,'2FA is not enabled');
  const verified=await verifySecondFactor({userId:user.id,secretEnc:user.twoFactorSecretEnc,code:body.code});
  if(!verified.ok) throw new HttpError(400,'Invalid authenticator or recovery code');
  await prisma.user.update({ where: { id: user.id }, data: { twoFactorEnabled: false, twoFactorSecretEnc: null, twoFactorPendingSecretEnc:null, twoFactorEnabledAt:null, twoFactorRecoveryCodeHashes:[] } });
  await prisma.securityEvent.create({data:{userId:user.id,type:'TWO_FACTOR_DISABLED'}});
  await audit({actorUserId:user.id,action:'TWO_FACTOR_DISABLED',targetType:'USER',targetId:user.id});
  res.json({ enabled: false });
}));
