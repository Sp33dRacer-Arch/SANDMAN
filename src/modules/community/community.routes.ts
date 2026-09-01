import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { asyncHandler } from '../../lib/async-handler';
import { HttpError } from '../../lib/http-error';
import { routeParam } from '../../lib/route-param';
import { requireAuth } from '../../middleware/auth';
import { createNotification } from '../../services/notification.service';
import { publicProduct } from '../../lib/public-product';
import { moderateTextLocal } from '../../services/content-moderation.service';

export const communityRouter = Router();

async function assertCanInteract(actorId: string, targetId: string) {
  const blocked = await prisma.userBlock.findFirst({ where: { OR: [{ blockerId: actorId, blockedId: targetId }, { blockerId: targetId, blockedId: actorId }] }, select: { id: true } });
  if (blocked) throw new HttpError(403, 'Interaction is unavailable');
}

async function assertCanMessage(actorId: string, targetId: string) {
  await assertCanInteract(actorId, targetId);
  const target = await prisma.user.findUnique({ where: { id: targetId }, select: { messagePrivacy: true } });
  if (!target) throw new HttpError(404, 'User not found');
  if (target.messagePrivacy === 'NOBODY') throw new HttpError(403, 'This user is not accepting messages');
  if (target.messagePrivacy === 'FOLLOWERS') {
    const follows = await prisma.userFollow.findUnique({ where: { followerId_followingId: { followerId: actorId, followingId: targetId } } });
    if (!follows) throw new HttpError(403, 'Only followers can message this user');
  }
}

communityRouter.get('/seller/stats', requireAuth, asyncHandler(async (req, res) => {
  const [listings, sales, offers, conversations, openCases, paidPayouts, payoutGroups] = await Promise.all([
    prisma.product.findMany({ where: { sellerId: req.auth!.userId, sourceType: 'MARKETPLACE' }, select: { id: true, status: true, viewCount: true, wishlistCount: true } }),
    prisma.orderItem.findMany({ where: { sellerId: req.auth!.userId, sourceType: 'MARKETPLACE', order: { paymentStatus: { in: ['PAID', 'PARTIALLY_REFUNDED'] } } }, include: { order: { select: { createdAt: true } } } }),
    prisma.offer.count({ where: { sellerId: req.auth!.userId, status: 'OPEN' } }),
    prisma.conversation.count({ where: { sellerId: req.auth!.userId } }),
    prisma.supportCase.count({ where: { sellerId: req.auth!.userId, status: { in: ['OPEN', 'UNDER_REVIEW', 'AWAITING_SELLER', 'APPROVED'] } } }),
    prisma.sellerPayout.aggregate({ where: { sellerId: req.auth!.userId, status: 'PAID' }, _sum: { amountCents: true, platformFeeCents: true }, _count: true }),
    prisma.sellerPayout.groupBy({ where: { sellerId: req.auth!.userId }, by: ['status'], _sum: { amountCents: true }, _count: true }),
  ]);
  const payoutByStatus = Object.fromEntries(payoutGroups.map(group => [group.status, group._sum.amountCents ?? 0]));
  const grossCents = sales.reduce((sum, item) => sum + item.totalPriceCents + item.sellerShippingCents, 0);
  const platformFeesCents = sales.reduce((sum, item) => sum + item.platformFeeCents, 0);
  const views = listings.reduce((sum, item) => sum + item.viewCount, 0);
  const unitsSold = sales.reduce((sum, item) => sum + item.quantity, 0);
  const shippingDue = sales.filter(item => !item.sellerShippedAt && Date.now() - item.order.createdAt.getTime() > 24 * 60 * 60 * 1000).length;
  res.json({
    listings: listings.length,
    activeListings: listings.filter(item => item.status === 'ACTIVE').length,
    views,
    wishlists: listings.reduce((sum, item) => sum + item.wishlistCount, 0),
    unitsSold,
    grossCents,
    platformFeesCents,
    conversionPercent: views ? (unitsSold / views) * 100 : 0,
    openOffers: offers,
    conversations,
    openCases,
    shippingDue,
    // Backwards-compatible payout fields now represent transferred funds only.
    payoutsCents: paidPayouts._sum.amountCents ?? 0,
    payoutCount: paidPayouts._count,
    pendingPayoutsCents: payoutByStatus.PENDING ?? 0,
    readyPayoutsCents: payoutByStatus.READY ?? 0,
    processingPayoutsCents: payoutByStatus.PROCESSING ?? 0,
    blockedPayoutsCents: payoutByStatus.BLOCKED ?? 0,
    failedPayoutsCents: payoutByStatus.FAILED ?? 0,
  });
}));

communityRouter.get('/seller/:sellerId', asyncHandler(async (req, res) => {
  const sellerId = routeParam(req.params.sellerId, 'sellerId');
  const paidMarketplaceWhere: Prisma.OrderItemWhereInput = { sellerId, sourceType: 'MARKETPLACE', order: { paymentStatus: { in: ['PAID', 'PARTIALLY_REFUNDED'] } } };
  const [seller, soldAggregate, soldLines, shippedLines, activeListingCount, listings] = await Promise.all([
    prisma.user.findUnique({
      where: { id: sellerId },
      select: {
        id: true, username: true, displayName: true, avatarUrl: true, firstName: true, lastName: true, createdAt: true, sellerCountry: true,
        sellerProfile: true,
      },
    }),
    prisma.orderItem.aggregate({ where: paidMarketplaceWhere, _sum: { quantity: true } }),
    prisma.orderItem.count({ where: paidMarketplaceWhere }),
    prisma.orderItem.count({ where: { ...paidMarketplaceWhere, sellerShippedAt: { not: null } } }),
    prisma.product.count({ where: { sellerId, sourceType: 'MARKETPLACE', status: 'ACTIVE' } }),
    prisma.product.findMany({
      where: { sellerId, sourceType: 'MARKETPLACE', status: 'ACTIVE' },
      include: { images: { orderBy: { position: 'asc' }, take: 1 }, category: true },
      orderBy: { createdAt: 'desc' },
      take: 24,
    }),
  ]);
  if (!seller) throw new HttpError(404, 'Seller not found');
  const sold = soldLines;
  const unitsSold = soldAggregate._sum.quantity ?? 0;
  const profile = seller.sellerProfile;
  const badges = [
    ...(profile?.verified ? ['VERIFIED'] : []),
    ...(profile?.ratingAverage != null && profile.ratingAverage >= 4.7 && profile.ratingCount >= 10 && soldLines >= 25 ? ['TOP_SELLER'] : []),
    ...(soldLines >= 50 ? ['EXPERIENCED_SELLER'] : []),
  ];
  res.json({
    seller,
    sold,
    unitsSold,
    listings: listings.map(publicProduct),
    reputation: {
      ratingAverage: profile?.ratingAverage ?? 0,
      ratingCount: profile?.ratingCount ?? 0,
      responseTimeHours: profile?.responseTimeHours ?? null,
      shippedOrderRate: soldLines ? Math.round((shippedLines / soldLines) * 1000) / 10 : null,
      activeListings: activeListingCount,
      memberSince: seller.createdAt,
      badges,
    },
  });
}));

communityRouter.use(requireAuth);

communityRouter.patch('/seller/profile', asyncHandler(async (req, res) => {
  const body = z.object({
    storeName: z.string().trim().min(2).max(100).nullable().optional(),
    bio: z.string().trim().max(1000).nullable().optional(),
    location: z.string().trim().max(160).nullable().optional(),
    responseTimeHours: z.number().int().min(0).max(720).nullable().optional(),
  }).parse(req.body);
  const safeBody = {
    ...body,
    storeName: body.storeName ? moderateTextLocal(body.storeName, 'Store name') : body.storeName,
    bio: body.bio ? moderateTextLocal(body.bio, 'Seller bio') : body.bio,
    location: body.location ? moderateTextLocal(body.location, 'Seller location') : body.location,
  };
  const profile = await prisma.sellerProfile.upsert({
    where: { userId: req.auth!.userId },
    update: safeBody,
    create: { userId: req.auth!.userId, ...safeBody },
  });
  res.json(profile);
}));

communityRouter.post('/offers', asyncHandler(async (req, res) => {
  const body = z.object({ productId: z.string().min(1), amountCents: z.number().int().min(100), message: z.string().trim().max(500).optional() }).parse(req.body);
  const product = await prisma.product.findFirst({ where: { id: body.productId, sourceType: 'MARKETPLACE', status: 'ACTIVE' } });
  if (!product?.sellerId) throw new HttpError(404, 'Marketplace listing not found');
  if (product.sellerId === req.auth!.userId) throw new HttpError(400, 'You cannot make an offer on your own listing');
  await assertCanInteract(req.auth!.userId, product.sellerId);
  if ((product.stockQuantity ?? 0) < 1) throw new HttpError(409, 'This listing is sold out');
  if (body.amountCents > product.priceCents * 2) throw new HttpError(400, 'Offer amount is not valid');
  const existingOpen = await prisma.offer.findFirst({ where: { productId: product.id, buyerId: req.auth!.userId, status: 'OPEN' } });
  if (existingOpen) throw new HttpError(409, 'You already have an active offer on this listing');
  const offer = await prisma.offer.create({
    data: {
      productId: product.id,
      buyerId: req.auth!.userId,
      sellerId: product.sellerId,
      createdById: req.auth!.userId,
      amountCents: body.amountCents,
      message: body.message ? moderateTextLocal(body.message, 'Offer message') : undefined,
      expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
    },
    include: { product: { select: { name: true, slug: true } } },
  });
  await createNotification({ userId: product.sellerId, type: 'OFFER', title: 'New offer', body: `You received an offer on ${product.name}.`, link: '#/seller?tab=offers' });
  res.status(201).json(offer);
}));

communityRouter.get('/offers', asyncHandler(async (req, res) => {
  const offers = await prisma.offer.findMany({
    where: { OR: [{ buyerId: req.auth!.userId }, { sellerId: req.auth!.userId }] },
    include: {
      product: { include: { images: { orderBy: { position: 'asc' }, take: 1 } } },
      buyer: { select: { id: true, firstName: true, lastName: true } },
      seller: { select: { id: true, firstName: true, lastName: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  res.json(offers);
}));

communityRouter.post('/offers/:id/respond', asyncHandler(async (req, res) => {
  const id = routeParam(req.params.id, 'id');
  const body = z.object({ action: z.enum(['ACCEPT', 'DECLINE', 'COUNTER', 'CANCEL']), amountCents: z.number().int().min(100).optional(), message: z.string().trim().max(500).optional() }).parse(req.body);
  const offer = await prisma.offer.findUnique({ where: { id }, include: { product: true } });
  if (!offer || (offer.buyerId !== req.auth!.userId && offer.sellerId !== req.auth!.userId)) throw new HttpError(404, 'Offer not found');
  if (offer.status !== 'OPEN') throw new HttpError(409, 'Offer is no longer active. Use the newest counter offer in the thread.');
  if (offer.expiresAt && offer.expiresAt < new Date()) {
    await prisma.offer.updateMany({ where: { id, status: 'OPEN' }, data: { status: 'EXPIRED' } });
    throw new HttpError(409, 'Offer has expired');
  }

  if (body.action === 'CANCEL') {
    if (offer.createdById !== req.auth!.userId) throw new HttpError(403, 'Only the person who made this offer can cancel it');
    const cancelled = await prisma.offer.updateMany({ where: { id, status: 'OPEN' }, data: { status: 'CANCELLED' } });
    if (cancelled.count !== 1) throw new HttpError(409, 'Offer was already changed by another request');
    return res.json({ success: true });
  }
  if (offer.createdById === req.auth!.userId) throw new HttpError(403, 'Wait for the other person to respond');

  const otherUserId = req.auth!.userId === offer.buyerId ? offer.sellerId : offer.buyerId;
  if (body.action === 'DECLINE') {
    const declined = await prisma.offer.updateMany({ where: { id, status: 'OPEN' }, data: { status: 'DECLINED' } });
    if (declined.count !== 1) throw new HttpError(409, 'Offer was already changed by another request');
    const updated = await prisma.offer.findUnique({ where: { id } });
    await createNotification({ userId: otherUserId, type: 'OFFER', title: 'Offer declined', body: `An offer on ${offer.product.name} was declined.`, link: '#/account?tab=offers' });
    return res.json(updated);
  }
  if (body.action === 'ACCEPT') {
    const updated = await prisma.$transaction(async tx => {
      const accepted = await tx.offer.updateMany({ where: { id, status: 'OPEN' }, data: { status: 'ACCEPTED', acceptedAt: new Date() } });
      if (accepted.count !== 1) throw new HttpError(409, 'Offer was already changed by another request');
      await tx.offer.updateMany({
        where: { id: { not: id }, productId: offer.productId, buyerId: offer.buyerId, sellerId: offer.sellerId, status: 'OPEN' },
        data: { status: 'EXPIRED' },
      });
      return tx.offer.findUnique({ where: { id } });
    });
    await createNotification({ userId: otherUserId, type: 'OFFER', title: 'Offer accepted', body: `Offer accepted for ${offer.product.name}.`, link: '#/account?tab=offers' });
    return res.json(updated);
  }
  if (!body.amountCents) throw new HttpError(400, 'Counter amount is required');
  const counter = await prisma.$transaction(async tx => {
    const countered = await tx.offer.updateMany({ where: { id, status: 'OPEN' }, data: { status: 'COUNTERED' } });
    if (countered.count !== 1) throw new HttpError(409, 'Offer was already changed by another request');
    return tx.offer.create({
      data: {
        productId: offer.productId,
        buyerId: offer.buyerId,
        sellerId: offer.sellerId,
        createdById: req.auth!.userId,
        amountCents: body.amountCents!,
        message: body.message,
        parentId: offer.id,
        expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
      },
    });
  });
  await createNotification({ userId: otherUserId, type: 'OFFER', title: 'Counter offer', body: `You received a counter offer on ${offer.product.name}.`, link: '#/account?tab=offers' });
  res.status(201).json(counter);
}));

communityRouter.post('/conversations', asyncHandler(async (req, res) => {
  const body = z.object({ productId: z.string().min(1), message: z.string().trim().min(1).max(2000) }).parse(req.body);
  const product = await prisma.product.findFirst({ where: { id: body.productId, sourceType: 'MARKETPLACE', status: 'ACTIVE' } });
  if (!product?.sellerId) throw new HttpError(404, 'Marketplace listing not found');
  if (product.sellerId === req.auth!.userId) throw new HttpError(400, 'You cannot message yourself');
  await assertCanMessage(req.auth!.userId, product.sellerId);
  const conversation = await prisma.conversation.upsert({
    where: { productId_buyerId_sellerId: { productId: product.id, buyerId: req.auth!.userId, sellerId: product.sellerId } },
    update: { updatedAt: new Date() },
    create: { productId: product.id, buyerId: req.auth!.userId, sellerId: product.sellerId },
  });
  const message = await prisma.message.create({ data: { conversationId: conversation.id, senderId: req.auth!.userId, body: moderateTextLocal(body.message, 'Message') } });
  await createNotification({ userId: product.sellerId, type: 'MESSAGE', title: 'New message', body: `Someone asked about ${product.name}.`, link: '#/messages' });
  res.status(201).json({ conversation, message });
}));

communityRouter.get('/conversations', asyncHandler(async (req, res) => {
  const rows = await prisma.conversation.findMany({
    where: { OR: [{ buyerId: req.auth!.userId }, { sellerId: req.auth!.userId }] },
    include: {
      product: { select: { id: true, name: true, slug: true, images: { orderBy: { position: 'asc' }, take: 1 } } },
      buyer: { select: { id: true, firstName: true, lastName: true } },
      seller: { select: { id: true, firstName: true, lastName: true } },
      messages: { orderBy: { createdAt: 'desc' }, take: 1 },
    },
    orderBy: { updatedAt: 'desc' },
  });
  res.json(rows);
}));

communityRouter.get('/conversations/:id/messages', asyncHandler(async (req, res) => {
  const id = routeParam(req.params.id, 'id');
  const conversation = await prisma.conversation.findFirst({ where: { id, OR: [{ buyerId: req.auth!.userId }, { sellerId: req.auth!.userId }] } });
  if (!conversation) throw new HttpError(404, 'Conversation not found');
  const messages = await prisma.message.findMany({ where: { conversationId: id }, orderBy: { createdAt: 'asc' }, take: 300 });
  await prisma.message.updateMany({ where: { conversationId: id, senderId: { not: req.auth!.userId }, readAt: null }, data: { readAt: new Date() } });
  res.json(messages);
}));

communityRouter.post('/conversations/:id/messages', asyncHandler(async (req, res) => {
  const id = routeParam(req.params.id, 'id');
  const { message } = z.object({ message: z.string().trim().min(1).max(2000) }).parse(req.body);
  const conversation = await prisma.conversation.findFirst({ where: { id, OR: [{ buyerId: req.auth!.userId }, { sellerId: req.auth!.userId }] }, include: { product: { select: { name: true } } } });
  if (!conversation) throw new HttpError(404, 'Conversation not found');
  const recipient = req.auth!.userId === conversation.buyerId ? conversation.sellerId : conversation.buyerId;
  await assertCanMessage(req.auth!.userId, recipient);
  const row = await prisma.$transaction(async tx => {
    const created = await tx.message.create({ data: { conversationId: id, senderId: req.auth!.userId, body: moderateTextLocal(message, 'Message') } });
    await tx.conversation.update({ where: { id }, data: { updatedAt: new Date() } });
    return created;
  });
  await createNotification({ userId: recipient, type: 'MESSAGE', title: 'New message', body: `New message about ${conversation.product.name}.`, link: '#/messages' });
  res.status(201).json(row);
}));
