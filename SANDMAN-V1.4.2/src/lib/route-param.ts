import { HttpError } from './http-error';

/**
 * Express 5 route parameters may be typed as string | string[] | undefined.
 * SANDMAN routes use scalar IDs/slugs, so normalize and validate them here.
 */
export function routeParam(value: unknown, name = 'parameter'): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new HttpError(400, `Invalid ${name}`);
  }
  return value;
}
