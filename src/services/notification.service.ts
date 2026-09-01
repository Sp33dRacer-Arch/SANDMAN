import { env } from '../config/env';
import { prisma } from '../lib/prisma';
import { sendEmail } from './email.service';

type NotificationInput = { userId: string; type: string; title: string; body: string; link?: string };

type Pref = {
  inAppFollowers: boolean;
  inAppFollowingActivity: boolean;
  inAppMessages: boolean;
  inAppMarketplace: boolean;
  inAppOrders: boolean;
  emailFollowingActivity: boolean;
  emailMessages: boolean;
  emailMarketplace: boolean;
  emailOrders: boolean;
  emailSecurity: boolean;
};

function category(type: string): 'followers'|'following'|'messages'|'orders'|'marketplace'|'security'|'other' {
  const value = type.toUpperCase();
  if (value === 'FOLLOW') return 'followers';
  if (value.startsWith('FOLLOWING_')) return 'following';
  if (value === 'MESSAGE') return 'messages';
  if (['ORDER','SHIPPING','PAYMENT','REFUND'].includes(value)) return 'orders';
  if (value === 'SECURITY') return 'security';
  if (['SALE','OFFER','CASE','DEALER_VERIFICATION','PRICE_DROP','RESTOCK','LISTING'].includes(value)) return 'marketplace';
  return 'other';
}

function inAppAllowed(pref: Pref | null, type: string) {
  if (!pref) return true;
  switch (category(type)) {
    case 'followers': return pref.inAppFollowers;
    case 'following': return pref.inAppFollowingActivity;
    case 'messages': return pref.inAppMessages;
    case 'orders': return pref.inAppOrders;
    case 'marketplace': return pref.inAppMarketplace;
    case 'security': return true; // Security notices cannot be fully silenced in-app.
    default: return true;
  }
}

function emailAllowed(pref: Pref | null, type: string) {
  if (!pref) return false;
  switch (category(type)) {
    case 'following': return pref.emailFollowingActivity;
    case 'messages': return pref.emailMessages;
    case 'orders': return pref.emailOrders;
    case 'marketplace': return pref.emailMarketplace;
    // SECURITY email contains richer device/context information and is sent by the security/auth flow.
    case 'security': return false;
    default: return false;
  }
}

function absoluteLink(link?: string) {
  if (!link) return undefined;
  if (/^https:\/\//i.test(link)) return link;
  const base = env.APP_URL.replace(/\/$/, '');
  if (link.startsWith('#')) return `${base}/${link}`;
  if (link.startsWith('/')) return `${base}${link}`;
  return `${base}/${link.replace(/^\/+/, '')}`;
}

export async function createNotification(input: NotificationInput) {
  const user = await prisma.user.findUnique({
    where: { id: input.userId },
    select: { email: true, notificationPreference: true, isActive: true },
  });
  if (!user?.isActive) return null;
  const pref = user.notificationPreference as Pref | null;
  const notification = inAppAllowed(pref, input.type)
    ? await prisma.notification.create({ data: input })
    : null;

  if (emailAllowed(pref, input.type)) {
    const link = absoluteLink(input.link);
    await sendEmail({
      to: user.email,
      subject: input.title,
      text: `${input.body}${link ? `\n\n${link}` : ''}`,
      html: `<p>${escapeHtml(input.body)}</p>${link ? `<p><a href="${escapeHtml(link)}">Open on SANDMAN</a></p>` : ''}`,
      type: 'ALERT',
    }).catch(() => undefined);
  }
  return notification;
}

export async function notifyFollowers(input: {
  actorUserId: string;
  type: 'FOLLOWING_LISTING' | 'FOLLOWING_POST' | 'FOLLOWING_BUILD';
  title: string;
  body: string;
  link?: string;
}) {
  const followers = await prisma.userFollow.findMany({
    where: { followingId: input.actorUserId },
    select: {
      followerId: true,
      follower: { select: { email: true, isActive: true, notificationPreference: true } },
    },
    take: 5000,
  });
  if (!followers.length) return { notified: 0 };

  const active = followers.filter(row => row.follower.isActive);
  const allowed = active.filter(row => row.follower.notificationPreference?.inAppFollowingActivity !== false);
  if (allowed.length) {
    await prisma.notification.createMany({
      data: allowed.map(row => ({ userId: row.followerId, type: input.type, title: input.title, body: input.body, link: input.link })),
    });
  }

  const emailFollowers = active.filter(row => row.follower.notificationPreference?.emailFollowingActivity === true);
  const link = absoluteLink(input.link);
  await Promise.allSettled(emailFollowers.slice(0, 200).map(row => sendEmail({
    to: row.follower.email,
    subject: input.title,
    text: `${input.body}${link ? `\n\n${link}` : ''}`,
    html: `<p>${escapeHtml(input.body)}</p>${link ? `<p><a href="${escapeHtml(link)}">Open on SANDMAN</a></p>` : ''}`,
    type: 'ALERT',
  })));
  return { notified: allowed.length };
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char] || char));
}
