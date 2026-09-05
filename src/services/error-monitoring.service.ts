import type { Request } from 'express';
import { env } from '../config/env';

function safeError(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message.slice(0, 2000),
      stack: error.stack?.slice(0, 12_000),
    };
  }
  return { name: 'UnknownError', message: String(error).slice(0, 2000) };
}

export function reportServerError(error: unknown, req?: Request) {
  if (!env.ERROR_MONITORING_WEBHOOK_URL) return;
  const payload = {
    service: 'SANDMAN',
    version: '2.5.0',
    environment: env.NODE_ENV,
    error: safeError(error),
    request: req ? {
      method: req.method,
      path: req.originalUrl.split('?')[0],
      requestId: req.get('x-request-id') || null,
    } : null,
    timestamp: new Date().toISOString(),
  };
  void fetch(env.ERROR_MONITORING_WEBHOOK_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(env.ERROR_MONITORING_WEBHOOK_SECRET ? { authorization: `Bearer ${env.ERROR_MONITORING_WEBHOOK_SECRET}` } : {}),
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(5_000),
  }).catch(() => undefined);
}
