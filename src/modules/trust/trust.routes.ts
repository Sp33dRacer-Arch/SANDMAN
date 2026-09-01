import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { asyncHandler } from '../../lib/async-handler';
import { HttpError } from '../../lib/http-error';
import { routeParam } from '../../lib/route-param';
import { requireAuth, requireRole } from '../../middleware/auth';
import { assertSafeImageUrls, moderateTextLocal } from '../../services/content-moderation.service';
import { createNotification } from '../../services/notification.service';
import { audit } from '../../services/audit.service';
import { scoreAccountRisk } from '../../services/risk-score.service';

export const trustRouter = Router();
trustRouter.use(requireAuth);

trustRouter.get('/dealer-verification', asyncHandler(async (req,res)=>{
  const [user,application]=await Promise.all([
    prisma.user.findUnique({where:{id:req.auth!.userId},select:{emailVerifiedAt:true,phoneVerifiedAt:true,twoFactorEnabled:true,sellerProfile:true}}),
    prisma.dealerVerificationApplication.findUnique({where:{userId:req.auth!.userId}}),
  ]);
  if(!user) throw new HttpError(404,'User not found');
  res.json({application,requirements:{emailVerified:Boolean(user.emailVerifiedAt),phoneVerified:Boolean(user.phoneVerifiedAt),twoFactorEnabled:user.twoFactorEnabled},verifiedDealer:Boolean(user.sellerProfile?.dealerVerifiedAt)});
}));

trustRouter.post('/dealer-verification', asyncHandler(async (req,res)=>{
  const body=z.object({
    businessName:z.string().trim().min(2).max(160),registrationNumber:z.string().trim().max(120).optional(),country:z.string().trim().min(2).max(80),address:z.string().trim().max(300).optional(),
    website:z.string().url().optional(),businessEmail:z.string().email(),phone:z.string().trim().max(40).optional(),description:z.string().trim().max(1500).optional(),documentUrls:z.array(z.string().url()).max(8).default([]),
  }).parse(req.body);
  const user=await prisma.user.findUnique({where:{id:req.auth!.userId},select:{emailVerifiedAt:true,phoneVerifiedAt:true,twoFactorEnabled:true}});
  if(!user) throw new HttpError(404,'User not found');
  if(!user.emailVerifiedAt) throw new HttpError(409,'Verify your email before applying for dealer verification');
  if(!user.phoneVerifiedAt) throw new HttpError(409,'Verify your phone before applying for dealer verification');
  if(!user.twoFactorEnabled) throw new HttpError(409,'Enable two-factor authentication before applying for dealer verification');
  const documentUrls=await assertSafeImageUrls(body.documentUrls,'DEALER_VERIFICATION_DOCUMENTS',req.auth!.userId);
  const data={...body,businessName:moderateTextLocal(body.businessName,'Business name'),description:body.description?moderateTextLocal(body.description,'Dealer description'):undefined,documentUrls,status:'PENDING' as const,submittedAt:new Date(),reviewedAt:null,reviewerId:null,reviewNotes:null};
  const application=await prisma.dealerVerificationApplication.upsert({where:{userId:req.auth!.userId},update:data,create:{userId:req.auth!.userId,...data}});
  await audit({actorUserId:req.auth!.userId,action:'DEALER_VERIFICATION_SUBMITTED',targetType:'DEALER_APPLICATION',targetId:application.id});
  res.status(201).json(application);
}));

export const adminTrustRouter = Router();
adminTrustRouter.use(requireAuth,requireRole('ADMIN','STAFF'));

adminTrustRouter.get('/summary', asyncHandler(async (_req,res)=>{
  const [openReports,pendingDealers,suspendedDealers,securityEvents,recentAudit]=await Promise.all([
    prisma.contentReport.count({where:{status:{in:['OPEN','REVIEWING']}}}),
    prisma.dealerVerificationApplication.count({where:{status:'PENDING'}}),
    prisma.dealerVerificationApplication.count({where:{status:'SUSPENDED'}}),
    prisma.securityEvent.count({where:{createdAt:{gte:new Date(Date.now()-24*60*60*1000)}}}),
    prisma.auditLog.count({where:{createdAt:{gte:new Date(Date.now()-24*60*60*1000)}}}),
  ]);
  res.json({openReports,pendingDealers,suspendedDealers,securityEvents24h:securityEvents,auditActions24h:recentAudit});
}));

adminTrustRouter.get('/dealer-verifications', asyncHandler(async (req,res)=>{
  const q=z.object({status:z.enum(['NOT_SUBMITTED','PENDING','APPROVED','REJECTED','SUSPENDED']).optional()}).parse(req.query);
  const rows=await prisma.dealerVerificationApplication.findMany({where:q.status?{status:q.status}:{},include:{user:{select:{id:true,email:true,username:true,displayName:true,firstName:true,lastName:true,emailVerifiedAt:true,phoneVerifiedAt:true,twoFactorEnabled:true,sellerProfile:true}}},orderBy:{submittedAt:'desc'},take:200});
  res.json(rows);
}));

adminTrustRouter.patch('/dealer-verifications/:id', asyncHandler(async (req,res)=>{
  const id=routeParam(req.params.id,'id');
  const body=z.object({status:z.enum(['APPROVED','REJECTED','SUSPENDED']),reviewNotes:z.string().trim().max(2000).optional()}).parse(req.body);
  const application=await prisma.dealerVerificationApplication.findUnique({where:{id}});
  if(!application) throw new HttpError(404,'Dealer application not found');
  const updated=await prisma.$transaction(async tx=>{
    const row=await tx.dealerVerificationApplication.update({where:{id},data:{status:body.status,reviewNotes:body.reviewNotes,reviewerId:req.auth!.userId,reviewedAt:new Date()}});
    await tx.sellerProfile.upsert({where:{userId:application.userId},update:{dealerVerifiedAt:body.status==='APPROVED'?new Date():null,verified:body.status==='APPROVED'},create:{userId:application.userId,dealerVerifiedAt:body.status==='APPROVED'?new Date():null,verified:body.status==='APPROVED'}});
    return row;
  });
  await createNotification({userId:application.userId,type:'DEALER_VERIFICATION',title:`Dealer verification ${body.status.toLowerCase()}`,body:body.status==='APPROVED'?'Your SANDMAN dealer verification was approved.':'Your dealer verification status changed. Open your account for details.',link:'#/account?tab=verification'});
  await audit({actorUserId:req.auth!.userId,action:`DEALER_VERIFICATION_${body.status}`,targetType:'DEALER_APPLICATION',targetId:id,metadata:{userId:application.userId}});
  res.json(updated);
}));

adminTrustRouter.get('/reports', asyncHandler(async (req,res)=>{
  const q=z.object({status:z.enum(['OPEN','REVIEWING','ACTIONED','DISMISSED']).optional()}).parse(req.query);
  const rows=await prisma.contentReport.findMany({where:q.status?{status:q.status}:{},include:{reporter:{select:{id:true,email:true,username:true,displayName:true}}},orderBy:{createdAt:'desc'},take:300});
  res.json(rows);
}));

adminTrustRouter.patch('/reports/:id', asyncHandler(async (req,res)=>{
  const id=routeParam(req.params.id,'id');
  const body=z.object({status:z.enum(['REVIEWING','ACTIONED','DISMISSED']),moderatorNotes:z.string().trim().max(2000).optional(),action:z.enum(['NONE','SUSPEND_USER','REMOVE_POST','ARCHIVE_LISTING']).default('NONE')}).parse(req.body);
  const report=await prisma.contentReport.findUnique({where:{id}});
  if(!report) throw new HttpError(404,'Report not found');
  if(body.action==='SUSPEND_USER'&&report.targetType==='USER') await prisma.user.updateMany({where:{id:report.targetId},data:{isActive:false}});
  if(body.action==='REMOVE_POST'&&report.targetType==='POST') await prisma.socialPost.updateMany({where:{id:report.targetId},data:{status:'REMOVED'}});
  if(body.action==='ARCHIVE_LISTING'&&report.targetType==='LISTING') await prisma.product.updateMany({where:{id:report.targetId},data:{status:'ARCHIVED'}});
  const updated=await prisma.contentReport.update({where:{id},data:{status:body.status,moderatorId:req.auth!.userId,moderatorNotes:body.moderatorNotes}});
  await audit({actorUserId:req.auth!.userId,action:`REPORT_${body.status}`,targetType:report.targetType,targetId:report.targetId,metadata:{reportId:id,enforcement:body.action}});
  res.json(updated);
}));

adminTrustRouter.get('/risk-users', asyncHandler(async (_req,res)=>{
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const users = await prisma.user.findMany({
    where:{isActive:true},
    select:{id:true,email:true,username:true,displayName:true,createdAt:true,emailVerifiedAt:true,phoneVerifiedAt:true,twoFactorEnabled:true,securityEvents:{where:{createdAt:{gte:since}},select:{type:true}}},
    orderBy:{createdAt:'desc'},
    take:200,
  });
  const ids=users.map(user=>user.id);
  const reports=ids.length?await prisma.contentReport.findMany({where:{targetType:'USER',targetId:{in:ids},status:{in:['OPEN','REVIEWING']}},select:{targetId:true}}):[];
  const reportCounts=new Map<string,number>();
  reports.forEach(report=>reportCounts.set(report.targetId,(reportCounts.get(report.targetId)||0)+1));
  const scored=users.map(user=>{
    const failed=user.securityEvents.filter(event=>event.type==='LOGIN_FAILED').length;
    const devices=user.securityEvents.filter(event=>event.type==='NEW_DEVICE_LOGIN').length;
    const impersonation=user.securityEvents.filter(event=>event.type==='POSSIBLE_IMPERSONATION').length;
    const risk=scoreAccountRisk({createdAt:user.createdAt,emailVerified:Boolean(user.emailVerifiedAt),phoneVerified:Boolean(user.phoneVerifiedAt),twoFactorEnabled:user.twoFactorEnabled,failedLogins7d:failed,newDeviceLogins7d:devices,openReports:reportCounts.get(user.id)||0,impersonationSignals7d:impersonation});
    return {id:user.id,email:user.email,username:user.username,displayName:user.displayName,createdAt:user.createdAt,...risk};
  }).filter(row=>row.score>0).sort((a,b)=>b.score-a.score).slice(0,100);
  res.json(scored);
}));

adminTrustRouter.get('/audit', asyncHandler(async (_req,res)=>{
  const rows=await prisma.auditLog.findMany({include:{actor:{select:{email:true,username:true}}},orderBy:{createdAt:'desc'},take:300});
  res.json(rows);
}));

adminTrustRouter.get('/security-events', asyncHandler(async (_req,res)=>{
  const rows=await prisma.securityEvent.findMany({include:{user:{select:{email:true,username:true}}},orderBy:{createdAt:'desc'},take:300});
  res.json(rows);
}));
