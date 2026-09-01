import { env } from '../config/env';

export type SandmanSms = { to: string; body: string; type: 'VERIFY_PHONE' | 'SECURITY' | 'GENERIC' };

async function sendViaTwilio(message: SandmanSms) {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_FROM_NUMBER) return null;
  const params = new URLSearchParams({ To: message.to, From: env.TWILIO_FROM_NUMBER, Body: message.body });
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(env.TWILIO_ACCOUNT_SID)}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params,
  });
  if (!response.ok) throw new Error(`Twilio returned ${response.status}`);
  return { delivered: true, provider: 'twilio' as const };
}

async function sendViaWebhook(message: SandmanSms) {
  if (!env.SMS_DELIVERY_WEBHOOK_URL) return null;
  const response = await fetch(env.SMS_DELIVERY_WEBHOOK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(env.SMS_DELIVERY_WEBHOOK_SECRET ? { Authorization: `Bearer ${env.SMS_DELIVERY_WEBHOOK_SECRET}` } : {}),
    },
    body: JSON.stringify(message),
  });
  if (!response.ok) throw new Error(`SMS delivery webhook returned ${response.status}`);
  return { delivered: true, provider: 'webhook' as const };
}

export async function sendSms(message: SandmanSms) {
  const twilio = await sendViaTwilio(message);
  if (twilio) return twilio;
  const webhook = await sendViaWebhook(message);
  if (webhook) return webhook;
  return { delivered: false, reason: 'No SMS provider configured' };
}
