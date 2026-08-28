import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import type { UserRole } from '@prisma/client';
import { env } from '../config/env';
import { HttpError } from '../lib/http-error';

type TokenPayload = { userId: string; role: UserRole; email: string };

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.header('authorization');
  if (!header?.startsWith('Bearer ')) return next(new HttpError(401, 'Authentication required'));

  try {
    req.auth = jwt.verify(header.slice(7), env.JWT_SECRET) as TokenPayload;
    next();
  } catch {
    next(new HttpError(401, 'Invalid or expired token'));
  }
}

export function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.header('authorization');
  if (!header?.startsWith('Bearer ')) return next();
  try {
    req.auth = jwt.verify(header.slice(7), env.JWT_SECRET) as TokenPayload;
  } catch {
    // Anonymous fallback for public endpoints.
  }
  next();
}

export function requireRole(...roles: UserRole[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth) return next(new HttpError(401, 'Authentication required'));
    if (!roles.includes(req.auth.role)) return next(new HttpError(403, 'Insufficient permissions'));
    next();
  };
}
