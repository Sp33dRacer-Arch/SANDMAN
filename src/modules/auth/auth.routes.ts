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

export const authRouter = Router();

const REFRESH_COOKIE = 'sandman_refresh';
const registerSchema = z.object({
  email: z.string().email().transform(v => v.toLowerCase()),
  password: z.string().min(8).max(128),
  firstName: z.string().min(1).max(80).optional(),
  lastName: z.string().min(1).max(80).optional(),
});

const publicUser = (user: { id: string; email: string; firstName: string | null; lastName: string | null; role: 'CUSTOMER' | 'ADMIN' | 'STAFF' }) => ({
  id: user.id,
  email: user.email,
  firstName: user.firstName,
  lastName: user.lastName,
  role: user.role,
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
  res.status(201).json({ user, token: signToken(user, session.sessionId) });
}));

authRouter.post('/login', asyncHandler(async (req, res) => {
  const data = z.object({ email: z.string().email(), password: z.string().min(1) }).parse(req.body);
  const user = await prisma.user.findUnique({ where: { email: data.email.toLowerCase() } });
  if (!user || !user.isActive || !(await bcrypt.compare(data.password, user.passwordHash))) {
    throw new HttpError(401, 'Invalid email or password');
  }

  const session = await createPersistentSession(req, res, user.id);
  res.json({ user: publicUser(user), token: signToken(user, session.sessionId) });
}));

authRouter.post('/refresh', asyncHandler(async (req, res) => {
  const raw = readCookie(req, REFRESH_COOKIE);
  if (!raw) throw new HttpError(401, 'No persistent session');

  const session = await prisma.authSession.findUnique({
    where: { tokenHash: refreshHash(raw) },
    include: { user: true },
  });
  if (!session || session.revokedAt || session.expiresAt <= new Date() || !session.user.isActive) {
    clearRefreshCookie(res);
    throw new HttpError(401, 'Persistent session expired');
  }

  await prisma.authSession.update({ where: { id: session.id }, data: { lastUsedAt: new Date() } });
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
    select: { id: true, email: true, firstName: true, lastName: true, phone: true, role: true, createdAt: true },
  });
  if (!user) throw new HttpError(404, 'User not found');
  res.json(user);
}));
