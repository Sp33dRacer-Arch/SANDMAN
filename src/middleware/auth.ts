import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import type { UserRole } from '@prisma/client';
import { env } from '../config/env';
import { HttpError } from '../lib/http-error';
import { prisma } from '../lib/prisma';

type TokenPayload = { userId: string; role: UserRole; email: string; sessionId: string };

async function validatedPayload(header?: string) {
  if (!header?.startsWith('Bearer ')) throw new HttpError(401, 'Authentication required');
  let decoded: TokenPayload;
  try {
    decoded = jwt.verify(header.slice(7), env.JWT_SECRET) as TokenPayload;
  } catch {
    throw new HttpError(401, 'Invalid or expired token');
  }
  if (!decoded.sessionId) throw new HttpError(401, 'Session is no longer valid');

  const session = await prisma.authSession.findFirst({
    where: {
      id: decoded.sessionId,
      userId: decoded.userId,
      revokedAt: null,
      expiresAt: { gt: new Date() },
      user: { isActive: true },
    },
    include: { user: true },
  });
  if (!session) throw new HttpError(401, 'Session is no longer valid');

  return {
    userId: session.user.id,
    role: session.user.role,
    email: session.user.email,
    sessionId: session.id,
  } satisfies TokenPayload;
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  validatedPayload(req.header('authorization'))
    .then(payload => { req.auth = payload; next(); })
    .catch(next);
}

export function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.header('authorization');
  if (!header?.startsWith('Bearer ')) return next();
  validatedPayload(header)
    .then(payload => { req.auth = payload; next(); })
    .catch(() => next());
}

export function requireRole(...roles: UserRole[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth) return next(new HttpError(401, 'Authentication required'));
    if (!roles.includes(req.auth.role)) return next(new HttpError(403, 'Insufficient permissions'));
    next();
  };
}
