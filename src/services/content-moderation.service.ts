import { env } from '../config/env';
import { HttpError } from '../lib/http-error';

const RESERVED_IDENTITY = new Set([
  'admin', 'administrator', 'support', 'security', 'moderator', 'official', 'staff', 'system',
  'sandman', 'sandmanadmin', 'sandmansupport', 'sandmansecurity', 'sandmanofficial',
]);

// Deliberately small, high-confidence list. The moderation webhook handles broader
// contextual content moderation; local validation exists to block obvious abuse
// even if an external moderation provider is temporarily unavailable.
const EXPLICIT_TERMS = [
  'porn', 'porno', 'pornography', 'xxx', 'onlyfans', 'nudes', 'nudez', 'sexcam',
  'dildo', 'vibrator', 'blowjob', 'handjob', 'cumshot', 'gangbang',
];
const EXPLICIT_PATTERNS = [
  /\bporn(?:o|ography)?\b/iu, /\bxxx\b/iu, /\bonlyfans\b/iu, /\bnudes?\b/iu,
  /\bsex\s*cam\b/iu, /\bdildo\b/iu, /\bvibrator\b/iu, /\bblow\s*job\b/iu,
  /\bhand\s*job\b/iu, /\bcum\s*shot\b/iu, /\bgang\s*bang\b/iu,
];

const URLISH = /(https?:\/\/|www\.|\.[a-z]{2,}(?:\/|$)|@[^\s]+\.[a-z]{2,})/i;
const CONTROL_OR_INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060\ufeff]/u;

function normalized(value: string) {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ');
}

function containsExplicitTerm(value: string) {
  const clean = value.normalize('NFKC').toLowerCase();
  // Word-aware matching avoids rejecting legitimate names such as “Draper”.
  if (EXPLICIT_PATTERNS.some(pattern => pattern.test(clean))) return true;
  const tokens = clean.split(/[^a-z0-9]+/).filter(Boolean);
  return tokens.some(token => EXPLICIT_TERMS.includes(token));
}

export function validatePersonalName(value: string, field = 'name') {
  const clean = normalized(value);
  if (clean.length < 1 || clean.length > 80) throw new HttpError(400, `${field} must be between 1 and 80 characters`);
  if (CONTROL_OR_INVISIBLE.test(clean) || URLISH.test(clean)) throw new HttpError(400, `${field} contains unsupported characters`);
  if (containsExplicitTerm(clean)) throw new HttpError(400, `${field} is not allowed`);
  // Unicode letters/marks support names from many languages. Spaces, apostrophes and hyphens are allowed.
  if (!/^[\p{L}\p{M}][\p{L}\p{M}'’\- .]*$/u.test(clean)) throw new HttpError(400, `${field} can only contain letters, spaces, apostrophes, periods and hyphens`);
  const identity = clean.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  if (RESERVED_IDENTITY.has(identity)) throw new HttpError(400, `${field} is reserved`);
  return clean;
}

export function validateUsername(value: string) {
  const clean = normalized(value).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,29}$/.test(clean)) throw new HttpError(400, 'Username must be 3–30 characters using letters, numbers, dots, underscores or hyphens');
  const key = clean.replace(/[._-]/g, '');
  if (RESERVED_IDENTITY.has(key) || key.startsWith('sandman') || EXPLICIT_TERMS.some(term => key.includes(term))) throw new HttpError(400, 'That username is not allowed');
  return clean;
}

export function moderateTextLocal(value: string, context = 'content') {
  const clean = normalized(value);
  if (CONTROL_OR_INVISIBLE.test(clean)) throw new HttpError(400, `${context} contains hidden or unsupported characters`);
  if (containsExplicitTerm(clean)) throw new HttpError(400, `${context} contains prohibited sexual content`);
  return clean;
}

export function validateDisplayName(value: string) {
  const clean = moderateTextLocal(value, 'Display name').slice(0, 80);
  const key = clean.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  if (RESERVED_IDENTITY.has(key) || key.startsWith('sandman')) {
    throw new HttpError(400, 'That display name could be mistaken for an official SANDMAN account');
  }
  return clean;
}

function safeImageUrl(url: string) {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new HttpError(400, 'Invalid image URL'); }
  if (parsed.protocol !== 'https:') throw new HttpError(400, 'Images must use HTTPS');
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const parts = host.split('.').map(Number);
  const [a = -1, b = -1] = parts;
  const privateIpv4 = parts.length === 4 && parts.every(part => Number.isInteger(part) && part >= 0 && part <= 255) && (
    a === 10 || a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
  const privateIpv6 = host === '::1' || host === '::' || /^f[cd][0-9a-f]*:/i.test(host) || /^fe[89ab][0-9a-f]*:/i.test(host);
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || privateIpv4 || privateIpv6) {
    throw new HttpError(400, 'Local or private-network image URLs are not allowed');
  }
  return parsed.toString();
}

type ModerationResponse = { allowed?: boolean; decision?: string; reasons?: string[]; labels?: string[] };

export async function assertSafeImageUrls(urls: string[], context: string, userId?: string) {
  const clean = [...new Set(urls.filter(Boolean).map(safeImageUrl))].slice(0, 12);
  if (!clean.length) return clean;

  // Production fails closed: user-supplied images cannot be published unless a safety scanner is configured.
  // Development can opt into the same behavior with REQUIRE_IMAGE_MODERATION=true.
  const enforceScanner = env.NODE_ENV === 'production' || env.REQUIRE_IMAGE_MODERATION;
  if (!env.CONTENT_MODERATION_WEBHOOK_URL) {
    if (enforceScanner) {
      throw new HttpError(503, 'Image safety scanning is not configured. Uploads are temporarily unavailable.');
    }
    return clean;
  }

  const response = await fetch(env.CONTENT_MODERATION_WEBHOOK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(env.CONTENT_MODERATION_WEBHOOK_SECRET ? { Authorization: `Bearer ${env.CONTENT_MODERATION_WEBHOOK_SECRET}` } : {}),
    },
    body: JSON.stringify({ type: 'IMAGE_MODERATION', urls: clean, context, userId }),
  });
  if (!response.ok) {
    if (enforceScanner) throw new HttpError(503, 'Image safety scanner is unavailable. Try again shortly.');
    return clean;
  }
  const result = await response.json().catch(() => ({})) as ModerationResponse;
  const decision = String(result.decision || '').toUpperCase();
  const explicitlyAllowed = result.allowed === true || ['ALLOW', 'ALLOWED', 'SAFE', 'PASS', 'APPROVE', 'APPROVED'].includes(decision);
  const explicitlyBlocked = result.allowed === false || ['BLOCK', 'BLOCKED', 'REJECT', 'REJECTED', 'UNSAFE'].includes(decision);
  if (explicitlyBlocked) throw new HttpError(400, 'One or more images were rejected by SANDMAN content safety');
  if (!explicitlyAllowed && enforceScanner) throw new HttpError(503, 'Image safety scanner returned an invalid decision. Uploads remain blocked.');
  return clean;
}

export function reservedIdentityWords() {
  return [...RESERVED_IDENTITY];
}
