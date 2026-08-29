import { env } from '../config/env';
import { HttpError } from '../lib/http-error';

const baseUrl = () => env.PAYPAL_MODE === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';

export function paypalConfigured() {
  return Boolean(env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET);
}

async function accessToken() {
  if (!paypalConfigured()) throw new HttpError(503, 'PayPal is not configured');
  const auth = Buffer.from(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`).toString('base64');
  const response = await fetch(`${baseUrl()}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const data = await response.json() as { access_token?: string; error_description?: string };
  if (!response.ok || !data.access_token) throw new HttpError(502, data.error_description || 'Unable to authenticate with PayPal');
  return data.access_token;
}

export async function createPayPalOrder(input: { localOrderId: string; orderNumber: string; amountCents: number; currency: string }) {
  const token = await accessToken();
  const response = await fetch(`${baseUrl()}/v2/checkout/orders`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [{
        reference_id: input.localOrderId,
        custom_id: input.localOrderId,
        invoice_id: input.orderNumber,
        amount: { currency_code: input.currency.toUpperCase(), value: (input.amountCents / 100).toFixed(2) },
      }],
      application_context: { shipping_preference: 'NO_SHIPPING', user_action: 'PAY_NOW' },
    }),
  });
  const data = await response.json() as any;
  if (!response.ok || !data?.id) throw new HttpError(502, data?.message || 'PayPal order creation failed');
  return data;
}

export async function capturePayPalOrder(paypalOrderId: string) {
  const token = await accessToken();
  const response = await fetch(`${baseUrl()}/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}/capture`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: '{}',
  });
  const data = await response.json() as any;
  if (!response.ok) throw new HttpError(502, data?.message || 'PayPal capture failed');
  return data;
}

export async function refundPayPalOrder(paypalOrderId: string, amountCents: number, currency: string, requestId?: string) {
  const token = await accessToken();
  const orderResponse = await fetch(`${baseUrl()}/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  const order = await orderResponse.json() as any;
  if (!orderResponse.ok) throw new HttpError(502, order?.message || 'Unable to load PayPal order for refund');
  const captureId = order?.purchase_units?.flatMap((u: any) => u?.payments?.captures ?? [])?.[0]?.id;
  if (!captureId) throw new HttpError(409, 'PayPal capture ID is unavailable for this order');
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
  };
  if (requestId) headers['PayPal-Request-Id'] = requestId;
  const response = await fetch(`${baseUrl()}/v2/payments/captures/${encodeURIComponent(captureId)}/refund`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ amount: { currency_code: currency.toUpperCase(), value: (amountCents / 100).toFixed(2) } }),
  });
  const data = await response.json() as any;
  if (!response.ok || !data?.id) throw new HttpError(502, data?.message || 'PayPal refund failed');
  return data;
}
