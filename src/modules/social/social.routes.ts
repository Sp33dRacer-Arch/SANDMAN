import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { asyncHandler } from '../../lib/async-handler';
import { HttpError } from '../../lib/http-error';
import { routeParam } from '../../lib/route-param';
import { optionalAuth, requireAuth } from '../../middleware/auth';
import { assertSafeImageUrls, moderateTextLocal, validateDisplayName, validatePersonalName, validateUsername } from '../../services/content-moderation.service';
import { createNotification, notifyFollowers } from '../../services/notification.service';
import { audit } from '../../services/audit.service';

export const socialRouter = Router();

async function blockExists(a: string, b: string) {
  const row = await prisma.userBlock.findFirst({
    where: { OR: [{ blockerId: a, blockedId: b }, { blockerId: b, blockedId: a }] },
    select: { id: true },
  });
  return Boolean(row);
}

socialRouter.get('/profiles/:username', optionalAuth, asyncHandler(async (req, res) => {
  const username = String(req.params.username || '').toLowerCase();
  const user = await prisma.user.findUnique({
    where: { username, isActive: true },
    select: {
      id: true, username: true, displayName: true, firstName: true, lastName: true, bio: true, avatarUrl: true, bannerUrl: true,
      country: true, createdAt: true, profileVisibility: true, showFollowing: true, sellerProfile: true,
      _count: { select: { followers: true, following: true, marketplaceProducts: true, socialPosts: true } },
    },
  });
  if (!user) throw new HttpError(404, 'Profile not found');
  const viewerId = req.auth?.userId;
  if (viewerId && await blockExists(viewerId, user.id)) throw new HttpError(404, 'Profile not found');
  const isOwner = viewerId === user.id;
  const isFollowing = viewerId ? Boolean(await prisma.userFollow.findUnique({ where: { followerId_followingId: { followerId: viewerId, followingId: user.id } } })) : false;
  if (!isOwner && user.profileVisibility === 'PRIVATE') throw new HttpError(403, 'This profile is private');
  if (!isOwner && user.profileVisibility === 'FOLLOWERS' && !isFollowing) throw new HttpError(403, 'Follow this user to view their profile');

  const [listings, posts] = await Promise.all([
    prisma.product.findMany({
      where: { sellerId: user.id, sourceType: 'MARKETPLACE', status: 'ACTIVE' },
      select: { id: true, slug: true, name: true, priceCents: true, currency: true, createdAt: true, images: { orderBy: { position: 'asc' }, take: 1 } },
      orderBy: { createdAt: 'desc' }, take: 12,
    }),
    prisma.socialPost.findMany({ where: { userId: user.id, status: 'PUBLISHED' }, orderBy: { createdAt: 'desc' }, take: 20 }),
  ]);
  res.json({ ...user, isOwner, isFollowing, listings, posts });
}));

socialRouter.patch('/profile', requireAuth, asyncHandler(async (req, res) => {
  const body = z.object({
    username: z.string().optional(),
    displayName: z.string().max(80).nullable().optional(),
    firstName: z.string().max(80).nullable().optional(),
    lastName: z.string().max(80).nullable().optional(),
    bio: z.string().max(600).nullable().optional(),
    avatarUrl: z.string().url().nullable().optional(),
    bannerUrl: z.string().url().nullable().optional(),
    country: z.string().max(80).nullable().optional(),
    profileVisibility: z.enum(['PUBLIC','FOLLOWERS','PRIVATE']).optional(),
    garageVisibility: z.enum(['PUBLIC','FOLLOWERS','PRIVATE']).optional(),
    messagePrivacy: z.enum(['EVERYONE','FOLLOWERS','NOBODY']).optional(),
    showFollowing: z.boolean().optional(),
    showOnlineStatus: z.boolean().optional(),
  }).parse(req.body);

  const data: any = { ...body };
  if (body.username !== undefined) data.username = validateUsername(body.username);
  if (body.firstName !== undefined && body.firstName !== null) data.firstName = validatePersonalName(body.firstName, 'First name');
  if (body.lastName !== undefined && body.lastName !== null) data.lastName = validatePersonalName(body.lastName, 'Last name');
  if (body.displayName !== undefined && body.displayName !== null) data.displayName = validateDisplayName(body.displayName);
  if (body.bio !== undefined && body.bio !== null) data.bio = moderateTextLocal(body.bio, 'Bio').slice(0,600);
  const media = await assertSafeImageUrls([body.avatarUrl || '', body.bannerUrl || ''].filter(Boolean), 'PROFILE_MEDIA', req.auth!.userId);
  if (body.avatarUrl) { const normalizedAvatar = new URL(body.avatarUrl).toString(); data.avatarUrl = media.includes(normalizedAvatar) ? normalizedAvatar : null; }
  if (body.bannerUrl) { const normalizedBanner = new URL(body.bannerUrl).toString(); data.bannerUrl = media.includes(normalizedBanner) ? normalizedBanner : null; }

  try {
    const user = await prisma.user.update({
      where: { id: req.auth!.userId }, data,
      select: { id:true,email:true,username:true,displayName:true,firstName:true,lastName:true,phone:true,phoneVerifiedAt:true,emailVerifiedAt:true,bio:true,avatarUrl:true,bannerUrl:true,country:true,profileVisibility:true,garageVisibility:true,messagePrivacy:true,showFollowing:true,showOnlineStatus:true },
    });
    // Do not ban people for sharing a real name. Instead, quietly flag unusually strong
    // identity overlap with a verified dealer for human review.
    if (user.avatarUrl && (user.displayName || (user.firstName && user.lastName))) {
      const identityName = (user.displayName || `${user.firstName || ''} ${user.lastName || ''}`).trim();
      const possibleImpersonation = await prisma.user.findFirst({
        where: {
          id: { not: user.id }, isActive: true, avatarUrl: user.avatarUrl,
          sellerProfile: { dealerVerifiedAt: { not: null } },
          OR: [
            ...(user.displayName ? [{ displayName: user.displayName }] : []),
            ...(user.firstName && user.lastName ? [{ firstName: user.firstName, lastName: user.lastName }] : []),
          ],
        },
        select: { id: true },
      });
      if (possibleImpersonation) {
        await prisma.securityEvent.create({ data: { userId:user.id, type:'POSSIBLE_IMPERSONATION', metadata:{ matchedVerifiedUserId:possibleImpersonation.id, identityName } } }).catch(()=>undefined);
      }
    }
    await audit({ actorUserId: req.auth!.userId, action: 'PROFILE_UPDATED', targetType: 'USER', targetId: req.auth!.userId });
    res.json(user);
  } catch (error: any) {
    if (String(error?.code) === 'P2002') throw new HttpError(409, 'That username is already taken');
    throw error;
  }
}));

socialRouter.get('/profiles/:userId/follow-status', optionalAuth, asyncHandler(async (req,res)=>{
  const followingId=routeParam(req.params.userId,'userId');
  if(!req.auth?.userId) return res.json({following:false,blocked:false});
  const [follow,blocked]=await Promise.all([
    prisma.userFollow.findUnique({where:{followerId_followingId:{followerId:req.auth.userId,followingId}},select:{createdAt:true}}),
    blockExists(req.auth.userId,followingId),
  ]);
  res.json({following:Boolean(follow),blocked});
}));

socialRouter.post('/profiles/:userId/follow', requireAuth, asyncHandler(async (req, res) => {
  const followingId = routeParam(req.params.userId, 'userId');
  if (followingId === req.auth!.userId) throw new HttpError(400, 'You cannot follow yourself');
  if (await blockExists(req.auth!.userId, followingId)) throw new HttpError(403, 'Follow is unavailable');
  const target = await prisma.user.findFirst({ where: { id: followingId, isActive: true }, select: { id:true, username:true, displayName:true, firstName:true } });
  if (!target) throw new HttpError(404, 'User not found');
  await prisma.userFollow.upsert({ where: { followerId_followingId: { followerId:req.auth!.userId, followingId } }, update:{}, create:{ followerId:req.auth!.userId, followingId } });
  const me = await prisma.user.findUnique({ where:{ id:req.auth!.userId }, select:{ username:true,displayName:true,firstName:true } });
  const who = me?.displayName || me?.username || me?.firstName || 'Someone';
  await createNotification({ userId: followingId, type:'FOLLOW', title:'New follower', body:`${who} followed you.`, link: me?.username ? `#/profile/${encodeURIComponent(me.username)}` : '#/account' });
  res.status(201).json({ following:true });
}));

socialRouter.delete('/profiles/:userId/follow', requireAuth, asyncHandler(async (req, res) => {
  await prisma.userFollow.deleteMany({ where:{ followerId:req.auth!.userId, followingId:routeParam(req.params.userId,'userId') } });
  res.status(204).send();
}));

socialRouter.get('/profiles/:userId/followers', optionalAuth, asyncHandler(async (req, res) => {
  const userId = routeParam(req.params.userId,'userId');
  const user = await prisma.user.findUnique({ where:{id:userId}, select:{showFollowing:true} });
  if (!user) throw new HttpError(404,'User not found');
  if (!user.showFollowing && req.auth?.userId !== userId) throw new HttpError(403,'Follower list is private');
  const rows = await prisma.userFollow.findMany({ where:{followingId:userId}, include:{ follower:{select:{id:true,username:true,displayName:true,firstName:true,lastName:true,avatarUrl:true}} }, orderBy:{createdAt:'desc'}, take:100 });
  res.json(rows.map(row=>row.follower));
}));

socialRouter.get('/profiles/:userId/following', optionalAuth, asyncHandler(async (req, res) => {
  const userId = routeParam(req.params.userId,'userId');
  const user = await prisma.user.findUnique({ where:{id:userId}, select:{showFollowing:true} });
  if (!user) throw new HttpError(404,'User not found');
  if (!user.showFollowing && req.auth?.userId !== userId) throw new HttpError(403,'Following list is private');
  const rows = await prisma.userFollow.findMany({ where:{followerId:userId}, include:{ following:{select:{id:true,username:true,displayName:true,firstName:true,lastName:true,avatarUrl:true}} }, orderBy:{createdAt:'desc'}, take:100 });
  res.json(rows.map(row=>row.following));
}));

socialRouter.post('/blocks/:userId', requireAuth, asyncHandler(async (req,res)=>{
  const blockedId=routeParam(req.params.userId,'userId');
  if(blockedId===req.auth!.userId) throw new HttpError(400,'You cannot block yourself');
  await prisma.$transaction([
    prisma.userBlock.upsert({where:{blockerId_blockedId:{blockerId:req.auth!.userId,blockedId}},update:{},create:{blockerId:req.auth!.userId,blockedId}}),
    prisma.userFollow.deleteMany({where:{OR:[{followerId:req.auth!.userId,followingId:blockedId},{followerId:blockedId,followingId:req.auth!.userId}]}}),
  ]);
  res.status(201).json({blocked:true});
}));

socialRouter.delete('/blocks/:userId', requireAuth, asyncHandler(async (req,res)=>{
  await prisma.userBlock.deleteMany({where:{blockerId:req.auth!.userId,blockedId:routeParam(req.params.userId,'userId')}});
  res.status(204).send();
}));

socialRouter.get('/blocks', requireAuth, asyncHandler(async (req,res)=>{
  const rows=await prisma.userBlock.findMany({where:{blockerId:req.auth!.userId},include:{blocked:{select:{id:true,username:true,displayName:true,firstName:true,lastName:true,avatarUrl:true}}},orderBy:{createdAt:'desc'}});
  res.json(rows.map(row=>row.blocked));
}));

socialRouter.post('/posts', requireAuth, asyncHandler(async (req,res)=>{
  const body=z.object({body:z.string().trim().min(1).max(3000),mediaUrls:z.array(z.string().url()).max(6).default([])}).parse(req.body);
  const text=moderateTextLocal(body.body,'Post');
  const media=await assertSafeImageUrls(body.mediaUrls,'SOCIAL_POST',req.auth!.userId);
  const post=await prisma.socialPost.create({data:{userId:req.auth!.userId,body:text,mediaUrls:media},include:{user:{select:{id:true,username:true,displayName:true,firstName:true,avatarUrl:true}}}});
  const actor=post.user.displayName||post.user.username||post.user.firstName||'Someone you follow';
  await notifyFollowers({actorUserId:req.auth!.userId,type:'FOLLOWING_POST',title:`${actor} posted`,body:text.slice(0,180),link:post.user.username?`#/profile/${encodeURIComponent(post.user.username)}`:'#/notifications'});
  res.status(201).json(post);
}));

socialRouter.delete('/posts/:id', requireAuth, asyncHandler(async (req,res)=>{
  const out=await prisma.socialPost.updateMany({where:{id:routeParam(req.params.id,'id'),userId:req.auth!.userId},data:{status:'REMOVED'}});
  if(!out.count) throw new HttpError(404,'Post not found');
  res.status(204).send();
}));

socialRouter.get('/feed', requireAuth, asyncHandler(async (req,res)=>{
  const follows=await prisma.userFollow.findMany({where:{followerId:req.auth!.userId},select:{followingId:true},take:1000});
  const ids=follows.map(row=>row.followingId);
  if(!ids.length) return res.json({posts:[],listings:[]});
  const [posts,listings]=await Promise.all([
    prisma.socialPost.findMany({where:{userId:{in:ids},status:'PUBLISHED'},include:{user:{select:{id:true,username:true,displayName:true,firstName:true,avatarUrl:true}}},orderBy:{createdAt:'desc'},take:50}),
    prisma.product.findMany({where:{sellerId:{in:ids},sourceType:'MARKETPLACE',status:'ACTIVE'},select:{id:true,slug:true,name:true,priceCents:true,currency:true,createdAt:true,sellerId:true,images:{orderBy:{position:'asc'},take:1},seller:{select:{username:true,displayName:true,firstName:true,avatarUrl:true}}},orderBy:{createdAt:'desc'},take:50}),
  ]);
  res.json({posts,listings});
}));

socialRouter.post('/reports', requireAuth, asyncHandler(async (req,res)=>{
  const body=z.object({reason:z.enum(['SCAM','COUNTERFEIT','SEXUAL_CONTENT','HATE_ABUSE','IMPERSONATION','SPAM','DANGEROUS_PRODUCT','MISLEADING_LISTING','STOLEN_IMAGE','OTHER']),details:z.string().trim().max(2000).optional(),targetType:z.enum(['USER','LISTING','POST','REVIEW','MESSAGE','IMAGE']),targetId:z.string().min(1).max(200)}).parse(req.body);
  const report=await prisma.contentReport.create({data:{reporterId:req.auth!.userId,...body}});
  await audit({actorUserId:req.auth!.userId,action:'CONTENT_REPORTED',targetType:body.targetType,targetId:body.targetId,metadata:{reason:body.reason}});
  res.status(201).json(report);
}));

socialRouter.get('/notification-preferences', requireAuth, asyncHandler(async (req,res)=>{
  const pref=await prisma.notificationPreference.upsert({where:{userId:req.auth!.userId},update:{},create:{userId:req.auth!.userId}});
  res.json(pref);
}));

socialRouter.patch('/notification-preferences', requireAuth, asyncHandler(async (req,res)=>{
  const body=z.object({
    inAppFollowers:z.boolean().optional(),inAppFollowingActivity:z.boolean().optional(),inAppMessages:z.boolean().optional(),inAppMarketplace:z.boolean().optional(),inAppOrders:z.boolean().optional(),
    emailFollowingActivity:z.boolean().optional(),emailMessages:z.boolean().optional(),emailMarketplace:z.boolean().optional(),emailOrders:z.boolean().optional(),emailSecurity:z.boolean().optional(),
  }).parse(req.body);
  const pref=await prisma.notificationPreference.upsert({where:{userId:req.auth!.userId},update:body,create:{userId:req.auth!.userId,...body}});
  res.json(pref);
}));
