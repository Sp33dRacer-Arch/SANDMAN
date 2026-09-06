import crypto from 'crypto';
import type { IncomingHttpHeaders } from 'http';
import { env } from '../config/env';
import { HttpError } from '../lib/http-error';

const API_TIMEOUT_MS = 15_000;
const TOKEN_SAFETY_WINDOW_MS = 60_000;
const CERT_CACHE_MS = 6 * 60 * 60 * 1000;

const baseUrl = () => env.PAYPAL_MODE === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';

let tokenCache: { token: string; expiresAt: number } | undefined;
const certCache = new Map<string, { pem: string; expiresAt: number }>();

export type PayPalShippingAddress = {
  firstName: string;
  lastName: string;
  line1: string;
  line2?: string;
  city: string;
  state?: string;
  postalCode: string;
  country: string;
};

type PayPalErrorBody = {
  name?: string;
  message?: string;
  debug_id?: string;
  error?: string;
  error_description?: string;
  details?: Array<{ issue?: string; description?: string }>;
};

export function paypalConfigured() {
  return Boolean(env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET);
}

export function paypalWebhookConfigured() {
  return paypalConfigured() && Boolean(env.PAYPAL_WEBHOOK_ID);
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = API_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new HttpError(504, 'PayPal request timed out');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function paypalErrorMessage(data: PayPalErrorBody | undefined, fallback: string) {
  const detail = data?.details?.find(item => item.description || item.issue);
  return detail?.description || detail?.issue || data?.message || data?.error_description || data?.error || fallback;
}

async function accessToken(forceRefresh = false) {
  if (!paypalConfigured()) throw new HttpError(503, 'PayPal is not configured');
  if (!forceRefresh && tokenCache && tokenCache.expiresAt - TOKEN_SAFETY_WINDOW_MS > Date.now()) return tokenCache.token;

  const auth = Buffer.from(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`).toString('base64');
  const response = await fetchWithTimeout(`${baseUrl()}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: 'grant_type=client_credentials',
  });
  const data = await response.json() as PayPalErrorBody & { access_token?: string; expires_in?: number };
  if (!response.ok || !data.access_token) {
    throw new HttpError(502, paypalErrorMessage(data, 'Unable to authenticate with PayPal'), { debugId: data.debug_id });
  }
  const ttlMs = Math.max(60, data.expires_in ?? 300) * 1000;
  tokenCache = { token: data.access_token, expiresAt: Date.now() + ttlMs };
  return data.access_token;
}

async function paypalJson<T>(
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
  retryAuth = true,
): Promise<T> {
  const token = await accessToken();
  const response = await fetchWithTimeout(`${baseUrl()}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(init.headers ?? {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  let data: PayPalErrorBody & T;
  try {
    data = (text ? JSON.parse(text) : {}) as PayPalErrorBody & T;
  } catch {
    throw new HttpError(502, 'PayPal returned an unreadable response');
  }
  if (response.status === 401 && retryAuth) {
    await accessToken(true);
    return paypalJson<T>(path, init, false);
  }
  if (!response.ok) {
    throw new HttpError(502, paypalErrorMessage(data, `PayPal request failed (${response.status})`), {
      debugId: data.debug_id,
      paypalName: data.name,
      httpStatus: response.status,
    });
  }
  return data as T;
}

function requestId(prefix: string, value: string) {
  return `${prefix}-${value}`.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 108);
}

export async function createPayPalOrder(input: {
  localOrderId: string;
  orderNumber: string;
  amountCents: number;
  currency: string;
  shippingAddress: PayPalShippingAddress;
}) {
  const address: Record<string, string> = {
    address_line_1: input.shippingAddress.line1,
    admin_area_2: input.shippingAddress.city,
    postal_code: input.shippingAddress.postalCode,
    country_code: input.shippingAddress.country.toUpperCase(),
  };
  if (input.shippingAddress.line2) address.address_line_2 = input.shippingAddress.line2;
  if (input.shippingAddress.state) address.admin_area_1 = input.shippingAddress.state;

  const data = await paypalJson<any>('/v2/checkout/orders', {
    method: 'POST',
    headers: {
      Prefer: 'return=representation',
      'PayPal-Request-Id': requestId('sandman-create', input.localOrderId),
    },
    body: {
      intent: 'CAPTURE',
      purchase_units: [{
        reference_id: input.localOrderId,
        custom_id: input.localOrderId,
        invoice_id: input.orderNumber,
        amount: {
          currency_code: input.currency.toUpperCase(),
          value: (input.amountCents / 100).toFixed(2),
        },
        shipping: {
          name: { full_name: `${input.shippingAddress.firstName} ${input.shippingAddress.lastName}`.trim() },
          address,
        },
      }],
      // Leave payment_source unset here so the same server-created order can be
      // confirmed by PayPal, Google Pay or Apple Pay in the browser. The buyer's
      // shipping address is still fixed on the purchase unit and the final amount
      // is revalidated after capture before fulfilment.
      application_context: {
        brand_name: env.PAYPAL_BRAND_NAME,
        shipping_preference: 'SET_PROVIDED_ADDRESS',
        user_action: 'PAY_NOW',
      },
    },
  });
  if (!data?.id) throw new HttpError(502, 'PayPal order creation returned no order ID');
  return data;
}

export async function getPayPalOrder(paypalOrderId: string) {
  return paypalJson<any>(`/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}`);
}

export async function capturePayPalOrder(paypalOrderId: string, localOrderId?: string) {
  const data = await paypalJson<any>(`/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}/capture`, {
    method: 'POST',
    headers: {
      Prefer: 'return=representation',
      'PayPal-Request-Id': requestId('sandman-capture', localOrderId || paypalOrderId),
    },
    body: {},
  });
  if (!data?.id) throw new HttpError(502, 'PayPal capture returned no order ID');
  return data;
}

export async function refundPayPalCapture(captureId: string, amountCents: number, currency: string, idempotencyKey?: string) {
  const data = await paypalJson<any>(`/v2/payments/captures/${encodeURIComponent(captureId)}/refund`, {
    method: 'POST',
    headers: {
      Prefer: 'return=representation',
      'PayPal-Request-Id': requestId('sandman-refund', idempotencyKey || captureId),
    },
    body: { amount: { currency_code: currency.toUpperCase(), value: (amountCents / 100).toFixed(2) } },
  });
  if (!data?.id) throw new HttpError(502, 'PayPal refund returned no refund ID');
  return data;
}

export async function refundPayPalOrder(paypalOrderId: string, amountCents: number, currency: string, idempotencyKey?: string) {
  const order = await getPayPalOrder(paypalOrderId);
  const captureId = order?.purchase_units?.flatMap((unit: any) => unit?.payments?.captures ?? [])?.[0]?.id;
  if (!captureId) throw new HttpError(409, 'PayPal capture ID is unavailable for this order');
  return refundPayPalCapture(captureId, amountCents, currency, idempotencyKey);
}

function crc32(buffer: Buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function headerValue(headers: IncomingHttpHeaders, name: string) {
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

async function paypalCertificate(certUrl: string) {
  const cached = certCache.get(certUrl);
  if (cached && cached.expiresAt > Date.now()) return cached.pem;
  const parsed = new URL(certUrl);
  if (parsed.protocol !== 'https:' || !(parsed.hostname === 'paypal.com' || parsed.hostname.endsWith('.paypal.com'))) {
    throw new HttpError(400, 'Invalid PayPal certificate URL');
  }
  const response = await fetchWithTimeout(certUrl, { method: 'GET', headers: { Accept: 'application/x-pem-file,text/plain,*/*' } });
  if (!response.ok) throw new HttpError(502, 'Unable to load PayPal webhook certificate');
  const pem = await response.text();
  if (!pem.includes('BEGIN CERTIFICATE')) throw new HttpError(502, 'PayPal webhook certificate is invalid');
  certCache.set(certUrl, { pem, expiresAt: Date.now() + CERT_CACHE_MS });
  return pem;
}

export async function verifyPayPalWebhookSignature(rawBody: Buffer, headers: IncomingHttpHeaders) {
  if (!env.PAYPAL_WEBHOOK_ID) throw new HttpError(503, 'PayPal webhook ID is not configured');
  const transmissionId = headerValue(headers, 'paypal-transmission-id');
  const transmissionTime = headerValue(headers, 'paypal-transmission-time');
  const transmissionSig = headerValue(headers, 'paypal-transmission-sig');
  const certUrl = headerValue(headers, 'paypal-cert-url');
  const authAlgo = headerValue(headers, 'paypal-auth-algo');
  if (!transmissionId || !transmissionTime || !transmissionSig || !certUrl || !authAlgo) {
    throw new HttpError(400, 'Missing PayPal webhook signature headers');
  }
  if (authAlgo.toUpperCase() !== 'SHA256WITHRSA') throw new HttpError(400, 'Unsupported PayPal webhook signature algorithm');

  const message = `${transmissionId}|${transmissionTime}|${env.PAYPAL_WEBHOOK_ID}|${crc32(rawBody)}`;
  const cert = await paypalCertificate(certUrl);
  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(message);
  verifier.end();
  const valid = verifier.verify(cert, Buffer.from(transmissionSig, 'base64'));
  if (!valid) throw new HttpError(400, 'Invalid PayPal webhook signature');
  return true;
}
