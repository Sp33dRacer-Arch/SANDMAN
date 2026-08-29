import { env } from '../config/env';

export type SandmanEmail = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  type: 'VERIFY_EMAIL' | 'PASSWORD_RESET' | 'ORDER' | 'SHIPPING' | 'ALERT' | 'GENERIC';
};

/**
 * Provider-neutral delivery hook. Point EMAIL_DELIVERY_WEBHOOK_URL at your
 * Resend/Postmark/SendGrid worker. SANDMAN never exposes reset tokens in API responses.
 */
export async function sendEmail(message: SandmanEmail) {
  if (!env.EMAIL_DELIVERY_WEBHOOK_URL) return { delivered: false, reason: 'EMAIL_DELIVERY_WEBHOOK_URL is not configured' };
  const response = await fetch(env.EMAIL_DELIVERY_WEBHOOK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(env.EMAIL_DELIVERY_WEBHOOK_SECRET ? { Authorization: `Bearer ${env.EMAIL_DELIVERY_WEBHOOK_SECRET}` } : {}),
    },
    body: JSON.stringify(message),
  });
  if (!response.ok) throw new Error(`Email delivery webhook returned ${response.status}`);
  return { delivered: true };
}
