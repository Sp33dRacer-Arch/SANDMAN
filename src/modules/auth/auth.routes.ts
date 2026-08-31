import { Router, type Request, type Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { createHash, randomBytes } from 'crypto';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { env } from '../../config/env';
import { asyncHandler } from '../../lib/async-handler';
import { HttpError } from '../../lib/http-error';
import { requireAuth } from '../../middleware/auth';
import { sendEmail } from '../../services/email.service';
import { decryptTotpSecret, verifyTotp } from '../../services/totp.service';

export const authRouter = Router();

const REFRESH_COOKIE = 'sandman_refresh';
const registerSchema = z.object({
  email: z.string().email().transform(v => v.toLowerCase()),
  password: z.string().min(8).max(128),
  firstName: z.string().min(1).max(80).optional(),
  lastName: z.string().min(1).max(80).optional(),
});

const publicUser = (user: { id: string; email: string; firstName: string | null; lastName: string | null; phone?: string | null; role: 'CUSTOMER' | 'ADMIN' | 'STAFF'; emailVerifiedAt?: Date | null; twoFactorEnabled?: boolean }) => ({
  id: user.id,
  email: user.email,
  firstName: user.firstName,
  lastName: user.lastName,
  phone: user.phone ?? null,
  role: user.role,
  emailVerified: Boolean(user.emailVerifiedAt),
  twoFactorEnabled: Boolean(user.twoFactorEnabled),
});

function signToken(user: { id: string; email: string; role: 'CUSTOMER' | 'ADMIN' | 'STAFF' }, sessionId: string) {
  return jwt.sign(
    { userId: user.id, email: user.email, role: user.role, sessionId },
    env.JWT_SECRET,
    { expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'] },
  );
}

function refreshHash(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

function readCookie(req: Request, name: string) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [rawName, ...rawValue] = part.trim().split('=');
    if (rawName === name) return decodeURIComponent(rawValue.join('='));
  }
  return undefined;
}

function sessionExpiry() {
  return new Date(Date.now() + env.SESSION_DAYS * 86_400_000);
}

function setRefreshCookie(res: Response, token: string, expiresAt: Date) {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/api/auth',
    expires: expiresAt,
  });
}

function clearRefreshCookie(res: Response) {
  res.clearCookie(REFRESH_COOKIE, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/api/auth',
  });
}

async function createPersistentSession(req: Request, res: Response, userId: string) {
  const token = randomBytes(48).toString('base64url');
  const expiresAt = sessionExpiry();
  const session = await prisma.authSession.create({
    data: {
      userId,
      tokenHash: refreshHash(token),
      expiresAt,
      userAgent: req.get('user-agent')?.slice(0, 500),
      ipAddress: req.ip?.slice(0, 100),
    },
  });
  setRefreshCookie(res, token, expiresAt);
  return { token, sessionId: session.id, expiresAt };
}

async function revokeRefreshSession(req: Request) {
  const token = readCookie(req, REFRESH_COOKIE);
  if (!token) return;
  await prisma.authSession.updateMany({
    where: { tokenHash: refreshHash(token), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

async function issueEmailVerification(user: { id: string; email: string }) {
  await prisma.emailVerificationToken.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: new Date() } });
  const raw = randomBytes(32).toString('base64url');
  await prisma.emailVerificationToken.create({ data: { userId: user.id, tokenHash: refreshHash(raw), expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) } });
  const link = `${env.APP_URL}/#/verify-email?token=${encodeURIComponent(raw)}`;
  await sendEmail({ to: user.email, subject: 'Verify your SANDMAN email', text: `Verify your email: ${link}`, html: `<p>Verify your SANDMAN email:</p><p><a href="${link}">Verify email</a></p>`, type: 'VERIFY_EMAIL' }).catch(() => undefined);
}

async function issuePasswordReset(user: { id: string; email: string }) {
  await prisma.passwordResetToken.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: new Date() } });
  const raw = randomBytes(32).toString('base64url');
  await prisma.passwordResetToken.create({ data: { userId: user.id, tokenHash: refreshHash(raw), expiresAt: new Date(Date.now() + 60 * 60 * 1000) } });
  const link = `${env.APP_URL}/#/reset-password?token=${encodeURIComponent(raw)}`;
  await sendEmail({ to: user.email, subject: 'Reset your SANDMAN password', text: `Reset your password: ${link}`, html: `<p>Reset your SANDMAN password:</p><p><a href="${link}">Reset password</a></p>`, type: 'PASSWORD_RESET' }).catch(() => undefined);
}

authRouter.post('/register', asyncHandler(async (req, res) => {
  const data = registerSchema.parse(req.body);
  const exists = await prisma.user.findUnique({ where: { email: data.email } });
  if (exists) throw new HttpError(409, 'Email already registered');

  const user = await prisma.user.create({
    data: {
      email: data.email,
      passwordHash: await bcrypt.hash(data.password, 12),
      firstName: data.firstName,
      lastName: data.lastName,
      cart: { create: {} },
    },
    select: { id: true, email: true, firstName: true, lastName: true, role: true, createdAt: true },
  });

  const session = await createPersistentSession(req, res, user.id);
  await issueEmailVerification(user);
  res.status(201).json({ user: publicUser(user), token: signToken(user, session.sessionId) });
}));

authRouter.post('/login', asyncHandler(async (req, res) => {
  const data = z.object({ email: z.string().email(), password: z.string().min(1) }).parse(req.body);
  const user = await prisma.user.findUnique({ where: { email: data.email.toLowerCase() } });
  if (!user || !user.isActive || !(await bcrypt.compare(data.password, user.passwordHash))) {
    throw new HttpError(401, 'Invalid email or password');
  }

  if (user.twoFactorEnabled && user.twoFactorSecretEnc) {
    const challengeToken = jwt.sign({ userId: user.id, purpose: '2fa' }, env.JWT_SECRET, { expiresIn: '5m' });
    return res.status(202).json({ requiresTwoFactor: true, challengeToken });
  }
  const session = await createPersistentSession(req, res, user.id);
  res.json({ user: publicUser(user), token: signToken(user, session.sessionId) });
}));

authRouter.post('/login/2fa', asyncHandler(async (req, res) => {
  const body = z.object({ challengeToken: z.string().min(1), code: z.string().regex(/^\d{6}$/) }).parse(req.body);
  let payload: { userId?: string; purpose?: string };
  try { payload = jwt.verify(body.challengeToken, env.JWT_SECRET) as { userId?: string; purpose?: string }; }
  catch { throw new HttpError(401, '2FA challenge expired'); }
  if (!payload.userId || payload.purpose !== '2fa') throw new HttpError(401, 'Invalid 2FA challenge');
  const user = await prisma.user.findUnique({ where: { id: payload.userId } });
  if (!user || !user.isActive || !user.twoFactorEnabled || !user.twoFactorSecretEnc) throw new HttpError(401, '2FA is unavailable for this account');
  if (!verifyTotp(decryptTotpSecret(user.twoFactorSecretEnc), body.code)) throw new HttpError(401, 'Invalid authenticator code');
  const session = await createPersistentSession(req, res, user.id);
  res.json({ user: publicUser(user), token: signToken(user, session.sessionId) });
}));

authRouter.post('/refresh', asyncHandler(async (req, res) => {
  const raw = readCookie(req, REFRESH_COOKIE);
  if (!raw) throw new HttpError(401, 'No persistent session');
  const oldHash = refreshHash(raw);

  const session = await prisma.authSession.findUnique({
    where: { tokenHash: oldHash },
    include: { user: true },
  });
  if (!session || session.revokedAt || session.expiresAt <= new Date() || !session.user.isActive) {
    clearRefreshCookie(res);
    throw new HttpError(401, 'Persistent session expired');
  }

  // Rotate the refresh token on every use so a copied old cookie cannot be
  // replayed for the full session lifetime.
  const rotated = randomBytes(48).toString('base64url');
  const claimed = await prisma.authSession.updateMany({
    where: {
      id: session.id,
      tokenHash: oldHash,
      revokedAt: null,
      expiresAt: { gt: new Date() },
    },
    data: { tokenHash: refreshHash(rotated), lastUsedAt: new Date() },
  });
  if (claimed.count !== 1) {
    clearRefreshCookie(res);
    throw new HttpError(401, 'Persistent session was already refreshed or revoked');
  }
  setRefreshCookie(res, rotated, session.expiresAt);
  res.json({ user: publicUser(session.user), token: signToken(session.user, session.id) });
}));

authRouter.post('/logout', asyncHandler(async (req, res) => {
  await revokeRefreshSession(req);
  const header = req.header('authorization');
  if (header?.startsWith('Bearer ')) {
    try {
      const decoded = jwt.verify(header.slice(7), env.JWT_SECRET) as { sessionId?: string; userId?: string };
      if (decoded.sessionId && decoded.userId) {
        await prisma.authSession.updateMany({
          where: { id: decoded.sessionId, userId: decoded.userId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      }
    } catch {
      // Logout remains successful even if the short-lived access token is already expired.
    }
  }
  clearRefreshCookie(res);
  res.status(204).send();
}));

authRouter.post('/forgot-password', asyncHandler(async (req, res) => {
  const { email } = z.object({ email: z.string().email().transform(v => v.toLowerCase()) }).parse(req.body);
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true, email: true, isActive: true } });
  if (user?.isActive) await issuePasswordReset(user);
  res.status(204).send();
}));

authRouter.post('/reset-password', asyncHandler(async (req, res) => {
  const body = z.object({ token: z.string().min(20), newPassword: z.string().min(10).max(128) }).parse(req.body);
  const token = await prisma.passwordResetToken.findUnique({ where: { tokenHash: refreshHash(body.token) } });
  if (!token || token.usedAt || token.expiresAt <= new Date()) throw new HttpError(400, 'Reset link is invalid or expired');
  const passwordHash = await bcrypt.hash(body.newPassword, 12);
  await prisma.$transaction(async tx => {
    const claimed = await tx.passwordResetToken.updateMany({
      where: { id: token.id, usedAt: null, expiresAt: { gt: new Date() } },
      data: { usedAt: new Date() },
    });
    if (claimed.count !== 1) throw new HttpError(400, 'Reset link is invalid or expired');
    await tx.user.update({ where: { id: token.userId }, data: { passwordHash } });
    await tx.authSession.updateMany({ where: { userId: token.userId, revokedAt: null }, data: { revokedAt: new Date() } });
  });
  clearRefreshCookie(res);
  res.status(204).send();
}));

authRouter.post('/email-verification/request', requireAuth, asyncHandler(async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.auth!.userId }, select: { id: true, email: true, emailVerifiedAt: true } });
  if (!user) throw new HttpError(404, 'User not found');
  if (!user.emailVerifiedAt) await issueEmailVerification(user);
  res.status(204).send();
}));

authRouter.post('/email-verification/confirm', asyncHandler(async (req, res) => {
  const { token: raw } = z.object({ token: z.string().min(20) }).parse(req.body);
  const token = await prisma.emailVerificationToken.findUnique({ where: { tokenHash: refreshHash(raw) } });
  if (!token || token.usedAt || token.expiresAt <= new Date()) throw new HttpError(400, 'Verification link is invalid or expired');
  await prisma.$transaction(async tx => {
    const claimed = await tx.emailVerificationToken.updateMany({
      where: { id: token.id, usedAt: null, expiresAt: { gt: new Date() } },
      data: { usedAt: new Date() },
    });
    if (claimed.count !== 1) throw new HttpError(400, 'Verification link is invalid or expired');
    await tx.user.update({ where: { id: token.userId }, data: { emailVerifiedAt: new Date() } });
  });
  res.status(204).send();
}));

authRouter.post('/change-password', requireAuth, asyncHandler(async (req, res) => {
  const data = z.object({
    currentPassword: z.string().min(1),
    newPassword: z.string().min(10).max(128),
  }).refine(v => v.currentPassword !== v.newPassword, { message: 'New password must be different', path: ['newPassword'] }).parse(req.body);

  const user = await prisma.user.findUnique({ where: { id: req.auth!.userId } });
  if (!user || !(await bcrypt.compare(data.currentPassword, user.passwordHash))) {
    throw new HttpError(401, 'Current password is incorrect');
  }

  await prisma.$transaction([
    prisma.user.update({ where: { id: user.id }, data: { passwordHash: await bcrypt.hash(data.newPassword, 12) } }),
    prisma.authSession.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } }),
  ]);

  clearRefreshCookie(res);
  const session = await createPersistentSession(req, res, user.id);
  res.json({ user: publicUser(user), token: signToken(user, session.sessionId), message: 'Password changed. Other sessions were signed out.' });
}));

authRouter.get('/me', requireAuth, asyncHandler(async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.auth!.userId },
    select: { id: true, email: true, firstName: true, lastName: true, phone: true, role: true, createdAt: true, emailVerifiedAt: true, twoFactorEnabled: true },
  });
  if (!user) throw new HttpError(404, 'User not found');
  res.json({ ...user, emailVerified: Boolean(user.emailVerifiedAt) });
}));

authRouter.patch('/me', requireAuth, asyncHandler(async (req, res) => {
  const data = z.object({
    firstName: z.string().trim().min(1).max(80).nullable().optional(),
    lastName: z.string().trim().min(1).max(80).nullable().optional(),
    phone: z.string().trim().min(5).max(40).nullable().optional(),
  }).parse(req.body);
  const user = await prisma.user.update({
    where: { id: req.auth!.userId },
    data,
    select: { id: true, email: true, firstName: true, lastName: true, phone: true, role: true, createdAt: true, emailVerifiedAt: true, twoFactorEnabled: true },
  });
  res.json({ ...user, emailVerified: Boolean(user.emailVerifiedAt) });
}));
