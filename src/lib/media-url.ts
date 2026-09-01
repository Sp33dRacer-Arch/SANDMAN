import { env } from '../config/env';

/**
 * User-submitted review/return evidence should come from SANDMAN's own signed
 * Cloudinary upload flow. This avoids rendering arbitrary third-party tracking
 * pixels or attacker-controlled image hosts in buyer/admin interfaces.
 */
export function isSandmanCloudinaryUrl(raw: string) {
  if (!env.CLOUDINARY_CLOUD_NAME) return false;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.hostname !== 'res.cloudinary.com') return false;
    const prefix = `/${encodeURIComponent(env.CLOUDINARY_CLOUD_NAME)}/image/upload/`;
    return url.pathname.startsWith(prefix);
  } catch {
    return false;
  }
}
