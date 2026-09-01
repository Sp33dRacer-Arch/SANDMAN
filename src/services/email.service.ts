import { env } from '../config/env';

export type SandmanEmail = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  type: 'VERIFY_EMAIL' | 'PASSWORD_RESET' | 'ORDER' | 'SHIPPING' | 'ALERT' | 'SECURITY' | 'GENERIC';
};

async function sendViaResend(message: SandmanEmail) {
  if (!env.RESEND_API_KEY) return null;
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to: [message.to],
      subject: message.subject,
      text: message.text,
      html: message.html,
      headers: { 'X-SANDMAN-Message-Type': message.type },
    }),
  });
  if (!response.ok) throw new Error(`Resend returned ${response.status}`);
  return { delivered: true, provider: 'resend' as const };
}

async function sendViaWebhook(message: SandmanEmail) {
  if (!env.EMAIL_DELIVERY_WEBHOOK_URL) return null;
  const response = await fetch(env.EMAIL_DELIVERY_WEBHOOK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(env.EMAIL_DELIVERY_WEBHOOK_SECRET ? { Authorization: `Bearer ${env.EMAIL_DELIVERY_WEBHOOK_SECRET}` } : {}),
    },
    body: JSON.stringify(message),
  });
  if (!response.ok) throw new Error(`Email delivery webhook returned ${response.status}`);
  return { delivered: true, provider: 'webhook' as const };
}

/**
 * Verification/security mail delivery. Configure Resend directly on Railway,
 * or keep using the signed provider-neutral webhook bridge.
 */
export async function sendEmail(message: SandmanEmail) {
  const resend = await sendViaResend(message);
  if (resend) return resend;
  const webhook = await sendViaWebhook(message);
  if (webhook) return webhook;
  return { delivered: false, reason: 'No email provider configured' };
}
