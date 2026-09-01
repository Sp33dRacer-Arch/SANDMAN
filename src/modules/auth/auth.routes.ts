import { Router, type Request, type Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { createHash, createHmac, randomBytes, randomInt } from 'crypto';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { env } from '../../config/env';
import { asyncHandler } from '../../lib/async-handler';
import { HttpError } from '../../lib/http-error';
import { requireAuth } from '../../middleware/auth';
import { sendEmail } from '../../services/email.service';
import { sendSms } from '../../services/sms.service';
import { validatePersonalName } from '../../services/content-moderation.service';
import { verifySecondFactor } from '../../services/two-factor.service';
import { createNotification } from '../../services/notification.service';
import { audit } from '../../services/audit.service';

export const authRouter = Router();

const REFRESH_COOKIE = 'sandman_refresh';
const strongPassword = z.string().min(10).max(128)
  .refine(v => /[a-z]/.test(v) && /[A-Z]/.test(v) && /\d/.test(v), 'Password must include uppercase, lowercase and a number');

const registerSchema = z.object({
  email: z.string().email().transform(v => v.toLowerCase()),
  password: strongPassword,
  firstName: z.string().min(1).max(80).optional(),
  lastName: z.string().min(1).max(80).optional(),
});

const publicUser = (user: any) => ({
  id: user.id,
  email: user.email,
  username: user.username ?? null,
  displayName: user.displayName ?? null,
  firstName: user.firstName ?? null,
  lastName: user.lastName ?? null,
  phone: user.phone ?? null,
  role: user.role,
  emailVerified: Boolean(user.emailVerifiedAt),
  phoneVerified: Boolean(user.phoneVerifiedAt),
  twoFactorEnabled: Boolean(user.twoFactorEnabled),
  avatarUrl: user.avatarUrl ?? null,
});

function signToken(user: { id: string; email: string; role: 'CUSTOMER' | 'ADMIN' | 'STAFF' }, sessionId: string) {
  return jwt.sign({ userId: user.id, email: user.email, role: user.role, sessionId }, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'] });
}

function refreshHash(token: string) { return createHash('sha256').update(token).digest('hex'); }
function codeHash(code: string) { return createHmac('sha256', env.JWT_SECRET).update(code).digest('hex'); }

function readCookie(req: Request, name: string) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [rawName, ...rawValue] = part.trim().split('=');
    if (rawName === name) return decodeURIComponent(rawValue.join('='));
  }
  return undefined;
}

function sessionExpiry() { return new Date(Date.now() + env.SESSION_DAYS * 86_400_000); }

function setRefreshCookie(res: Response, token: string, expiresAt: Date) {
  res.cookie(REFRESH_COOKIE, token, { httpOnly: true, secure: env.NODE_ENV === 'production', sameSite: 'lax', path: '/api/auth', expires: expiresAt });
}
function clearRefreshCookie(res: Response) {
  res.clearCookie(REFRESH_COOKIE, { httpOnly: true, secure: env.NODE_ENV === 'production', sameSite: 'lax', path: '/api/auth' });
}

async function createPersistentSession(req: Request, res: Response, userId: string, notifyNewDevice = true) {
  const token = randomBytes(48).toString('base64url');
  const expiresAt = sessionExpiry();
  const userAgent = req.get('user-agent')?.slice(0, 500) || null;
  const ipAddress = req.ip?.slice(0, 100) || null;
  const known = notifyNewDevice ? await prisma.authSession.findFirst({ where: { userId, userAgent, ipAddress }, select: { id: true } }) : null;
  const session = await prisma.authSession.create({ data: { userId, tokenHash: refreshHash(token), expiresAt, userAgent, ipAddress } });
  setRefreshCookie(res, token, expiresAt);

  if (notifyNewDevice && !known) {
    const user = await prisma.user.findUnique({ where: { id:userId }, select:{email:true,notificationPreference:true} });
    await prisma.securityEvent.create({ data:{userId,type:'NEW_DEVICE_LOGIN',ipAddress,userAgent} }).catch(()=>undefined);
    await createNotification({userId,type:'SECURITY',title:'New sign-in detected',body:'SANDMAN detected a sign-in from a new browser or network.',link:'#/account?tab=security'}).catch(()=>undefined);
    if (user?.notificationPreference?.emailSecurity !== false) {
      await sendEmail({to:user!.email,subject:'New SANDMAN sign-in',text:`A new sign-in was detected.\nBrowser: ${userAgent || 'Unknown'}\nIP: ${ipAddress || 'Unknown'}\nIf this was not you, change your password and revoke other sessions.`,html:`<h2>New SANDMAN sign-in</h2><p>A new sign-in was detected.</p><p><b>Browser:</b> ${escapeHtml(userAgent || 'Unknown')}<br><b>IP:</b> ${escapeHtml(ipAddress || 'Unknown')}</p><p>If this was not you, change your password and revoke other sessions.</p>`,type:'SECURITY'}).catch(()=>undefined);
    }
  }
  return { token, sessionId: session.id, expiresAt };
}

async function revokeRefreshSession(req: Request) {
  const token = readCookie(req, REFRESH_COOKIE);
  if (!token) return;
  await prisma.authSession.updateMany({ where: { tokenHash: refreshHash(token), revokedAt: null }, data: { revokedAt: new Date() } });
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char] || char));
}

async function requireSensitiveAuth(userId: string, password: string, code?: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || !user.isActive || !(await bcrypt.compare(password, user.passwordHash))) throw new HttpError(401, 'Password is incorrect');
  if (user.twoFactorEnabled && user.twoFactorSecretEnc) {
    if (!code) throw new HttpError(400, 'Authenticator or recovery code is required');
    const verified = await verifySecondFactor({ userId: user.id, secretEnc: user.twoFactorSecretEnc, code });
    if (!verified.ok) throw new HttpError(400, 'Invalid authenticator or recovery code');
  }
  return user;
}

async function issueEmailVerification(user: { id: string; email: string }) {
  await prisma.emailVerificationToken.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: new Date() } });
  const raw = randomBytes(32).toString('base64url');
  const code = String(randomInt(100000, 1000000));
  await prisma.emailVerificationToken.create({ data: { userId: user.id, tokenHash: refreshHash(raw), codeHash: codeHash(code), expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) } });
  const link = `${env.APP_URL.replace(/\/$/,'')}/verify-email?token=${encodeURIComponent(raw)}`;
  const result = await sendEmail({
    to: user.email,
    subject: `${code} is your SANDMAN verification code`,
    text: `Your SANDMAN verification code is ${code}. It expires in 24 hours.\n\nOr verify with this secure link: ${link}`,
    html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto"><p style="letter-spacing:.18em;font-size:12px">SANDMAN SECURITY</p><h1>Verify your email</h1><p>Enter this 6-digit code in SANDMAN:</p><p style="font-size:34px;letter-spacing:.22em;font-weight:700">${code}</p><p>Or use the secure verification link:</p><p><a href="${escapeHtml(link)}">Verify email</a></p><p style="color:#666">This code expires in 24 hours. Never send it to another person.</p></div>`,
    type: 'VERIFY_EMAIL',
  });
  if (!result.delivered && env.NODE_ENV === 'production') throw new HttpError(503, 'Verification email delivery is not configured');
  return result;
}

async function issueEmailChange(user: { id: string; email: string }, newEmail: string) {
  await prisma.emailChangeToken.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: new Date() } });
  const raw = randomBytes(32).toString('base64url');
  const code = String(randomInt(100000, 1000000));
  await prisma.emailChangeToken.create({ data: { userId: user.id, newEmail, tokenHash: refreshHash(raw), codeHash: codeHash(code), expiresAt: new Date(Date.now() + 30 * 60 * 1000) } });
  const link = `${env.APP_URL.replace(/\/$/,'')}/email-change?token=${encodeURIComponent(raw)}`;
  const result = await sendEmail({
    to: newEmail,
    subject: `${code} confirms your new SANDMAN email`,
    text: `Confirm this email as your new SANDMAN address with code ${code}. It expires in 30 minutes.\n\nOr open: ${link}`,
    html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto"><p style="letter-spacing:.18em;font-size:12px">SANDMAN SECURITY</p><h1>Confirm your new email</h1><p>Enter this code while signed in:</p><p style="font-size:34px;letter-spacing:.22em;font-weight:700">${code}</p><p><a href="${escapeHtml(link)}">Confirm new email</a></p><p style="color:#666">This request expires in 30 minutes.</p></div>`,
    type: 'SECURITY',
  });
  if (!result.delivered && env.NODE_ENV === 'production') throw new HttpError(503, 'Email delivery is not configured');
  await sendEmail({
    to: user.email,
    subject: 'SANDMAN email change requested',
    text: `A request was made to change your SANDMAN email to ${newEmail}. If you did not make this request, change your password and revoke other sessions immediately.`,
    html: `<h2>Email change requested</h2><p>A request was made to change your SANDMAN email to <b>${escapeHtml(newEmail)}</b>.</p><p>If this was not you, change your password and revoke other sessions immediately.</p>`,
    type: 'SECURITY',
  }).catch(() => undefined);
  return result;
}

async function issuePasswordReset(user: { id: string; email: string }) {
  await prisma.passwordResetToken.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: new Date() } });
  const raw = randomBytes(32).toString('base64url');
  await prisma.passwordResetToken.create({ data: { userId: user.id, tokenHash: refreshHash(raw), expiresAt: new Date(Date.now() + 60 * 60 * 1000) } });
  const link = `${env.APP_URL.replace(/\/$/,'')}/reset-password?token=${encodeURIComponent(raw)}`;
  await sendEmail({ to: user.email, subject: 'Reset your SANDMAN password', text: `Reset your password: ${link}`, html: `<p>Reset your SANDMAN password:</p><p><a href="${escapeHtml(link)}">Reset password</a></p>`, type: 'PASSWORD_RESET' }).catch(() => undefined);
}

authRouter.post('/register', asyncHandler(async (req, res) => {
  const data = registerSchema.parse(req.body);
  const exists = await prisma.user.findUnique({ where: { email: data.email } });
  if (exists) throw new HttpError(409, 'Email already registered');
  const firstName=data.firstName?validatePersonalName(data.firstName,'First name'):undefined;
  const lastName=data.lastName?validatePersonalName(data.lastName,'Last name'):undefined;
  const user = await prisma.user.create({
    data: { email: data.email, passwordHash: await bcrypt.hash(data.password, 12), firstName, lastName, cart: { create: {} }, notificationPreference:{create:{}} },
    select: { id:true,email:true,username:true,displayName:true,firstName:true,lastName:true,phone:true,role:true,emailVerifiedAt:true,phoneVerifiedAt:true,twoFactorEnabled:true,avatarUrl:true },
  });
  const session = await createPersistentSession(req, res, user.id, false);
  let verificationEmailSent = false;
  try { await issueEmailVerification(user); verificationEmailSent = true; }
  catch { verificationEmailSent = false; }
  res.status(201).json({ user: publicUser(user), token: signToken(user, session.sessionId), verificationEmailSent });
}));

authRouter.post('/login', asyncHandler(async (req, res) => {
  const data = z.object({ email: z.string().email(), password: z.string().min(1) }).parse(req.body);
  const user = await prisma.user.findUnique({ where: { email: data.email.toLowerCase() } });
  const loginIp = req.ip?.slice(0,100) || null;
  if (user?.isActive && loginIp) {
    const recentFailures = await prisma.securityEvent.count({ where: { userId:user.id, type:'LOGIN_FAILED', ipAddress:loginIp, createdAt:{gte:new Date(Date.now()-15*60*1000)} } });
    if (recentFailures >= 8) throw new HttpError(429, 'Too many sign-in attempts from this network. Try again in about 15 minutes.');
  }
  const valid = user && user.isActive ? await bcrypt.compare(data.password, user.passwordHash) : false;
  if (!valid) {
    if(user) await prisma.securityEvent.create({data:{userId:user.id,type:'LOGIN_FAILED',ipAddress:loginIp,userAgent:req.get('user-agent')?.slice(0,500)}}).catch(()=>undefined);
    throw new HttpError(401, 'Invalid email or password');
  }
  if (user!.twoFactorEnabled && user!.twoFactorSecretEnc) {
    const challengeToken = jwt.sign({ userId: user!.id, purpose: '2fa' }, env.JWT_SECRET, { expiresIn: '5m' });
    return res.status(202).json({ requiresTwoFactor: true, challengeToken });
  }
  const session = await createPersistentSession(req, res, user!.id);
  res.json({ user: publicUser(user), token: signToken(user!, session.sessionId) });
}));

authRouter.post('/login/2fa', asyncHandler(async (req, res) => {
  const body = z.object({ challengeToken: z.string().min(1), code: z.string().trim().min(6).max(32) }).parse(req.body);
  let payload: { userId?: string; purpose?: string };
  try { payload = jwt.verify(body.challengeToken, env.JWT_SECRET) as { userId?: string; purpose?: string }; }
  catch { throw new HttpError(401, '2FA challenge expired'); }
  if (!payload.userId || payload.purpose !== '2fa') throw new HttpError(401, 'Invalid 2FA challenge');
  const user = await prisma.user.findUnique({ where: { id: payload.userId } });
  if (!user || !user.isActive || !user.twoFactorEnabled || !user.twoFactorSecretEnc) throw new HttpError(401, '2FA is unavailable for this account');
  const verified=await verifySecondFactor({userId:user.id,secretEnc:user.twoFactorSecretEnc,code:body.code});
  if (!verified.ok) throw new HttpError(401, 'Invalid authenticator or recovery code');
  const session = await createPersistentSession(req, res, user.id);
  res.json({ user: publicUser(user), token: signToken(user, session.sessionId), usedRecoveryCode:verified.method==='recovery' });
}));

authRouter.post('/refresh', asyncHandler(async (req, res) => {
  const raw = readCookie(req, REFRESH_COOKIE);
  if (!raw) throw new HttpError(401, 'No persistent session');
  const oldHash = refreshHash(raw);
  const session = await prisma.authSession.findUnique({ where: { tokenHash: oldHash }, include: { user: true } });
  if (!session || session.revokedAt || session.expiresAt <= new Date() || !session.user.isActive) { clearRefreshCookie(res); throw new HttpError(401, 'Persistent session expired'); }
  const rotated = randomBytes(48).toString('base64url');
  const claimed = await prisma.authSession.updateMany({ where: { id: session.id, tokenHash: oldHash, revokedAt: null, expiresAt: { gt: new Date() } }, data: { tokenHash: refreshHash(rotated), lastUsedAt: new Date() } });
  if (claimed.count !== 1) { clearRefreshCookie(res); throw new HttpError(401, 'Persistent session was already refreshed or revoked'); }
  setRefreshCookie(res, rotated, session.expiresAt);
  res.json({ user: publicUser(session.user), token: signToken(session.user, session.id) });
}));

authRouter.post('/logout', asyncHandler(async (req, res) => {
  await revokeRefreshSession(req);
  const header = req.header('authorization');
  if (header?.startsWith('Bearer ')) {
    try {
      const decoded = jwt.verify(header.slice(7), env.JWT_SECRET) as { sessionId?: string; userId?: string };
      if (decoded.sessionId && decoded.userId) await prisma.authSession.updateMany({ where: { id: decoded.sessionId, userId: decoded.userId, revokedAt: null }, data: { revokedAt: new Date() } });
    } catch {}
  }
  clearRefreshCookie(res); res.status(204).send();
}));

authRouter.post('/forgot-password', asyncHandler(async (req, res) => {
  const { email } = z.object({ email: z.string().email().transform(v => v.toLowerCase()) }).parse(req.body);
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true, email: true, isActive: true } });
  if (user?.isActive) await issuePasswordReset(user);
  res.status(204).send();
}));

authRouter.post('/reset-password', asyncHandler(async (req, res) => {
  const body = z.object({ token: z.string().min(20), newPassword: strongPassword }).parse(req.body);
  const token = await prisma.passwordResetToken.findUnique({ where: { tokenHash: refreshHash(body.token) } });
  if (!token || token.usedAt || token.expiresAt <= new Date()) throw new HttpError(400, 'Reset link is invalid or expired');
  const passwordHash = await bcrypt.hash(body.newPassword, 12);
  await prisma.$transaction(async tx => {
    const claimed = await tx.passwordResetToken.updateMany({ where: { id: token.id, usedAt: null, expiresAt: { gt: new Date() } }, data: { usedAt: new Date() } });
    if (claimed.count !== 1) throw new HttpError(400, 'Reset link is invalid or expired');
    await tx.user.update({ where: { id: token.userId }, data: { passwordHash } });
    await tx.authSession.updateMany({ where: { userId: token.userId, revokedAt: null }, data: { revokedAt: new Date() } });
  });
  await audit({actorUserId:token.userId,action:'PASSWORD_RESET',targetType:'USER',targetId:token.userId}).catch(()=>undefined);
  clearRefreshCookie(res); res.status(204).send();
}));

authRouter.post('/email-verification/request', requireAuth, asyncHandler(async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.auth!.userId }, select: { id: true, email: true, emailVerifiedAt: true } });
  if (!user) throw new HttpError(404, 'User not found');
  if (!user.emailVerifiedAt) await issueEmailVerification(user);
  res.status(204).send();
}));

authRouter.post('/email-verification/confirm', asyncHandler(async (req, res) => {
  const { token: raw } = z.object({ token: z.string().min(20) }).parse(req.body);
  const token = await prisma.emailVerificationToken.findUnique({ where: { tokenHash: refreshHash(raw) } });
  if (!token || token.usedAt || token.expiresAt <= new Date()) throw new HttpError(400, 'Verification link is invalid or expired');
  await confirmEmailToken(token.id,token.userId);
  res.status(204).send();
}));

authRouter.post('/email-verification/confirm-code', requireAuth, asyncHandler(async (req,res)=>{
  const {code}=z.object({code:z.string().regex(/^\d{6}$/)}).parse(req.body);
  const token=await prisma.emailVerificationToken.findFirst({where:{userId:req.auth!.userId,usedAt:null,expiresAt:{gt:new Date()}},orderBy:{createdAt:'desc'}});
  if(!token?.codeHash||token.attempts>=6) throw new HttpError(400,'Verification code is invalid or expired');
  if(token.codeHash!==codeHash(code)) {
    await prisma.emailVerificationToken.update({where:{id:token.id},data:{attempts:{increment:1}}});
    throw new HttpError(400,'Verification code is invalid or expired');
  }
  await confirmEmailToken(token.id,token.userId);
  res.status(204).send();
}));

async function confirmEmailToken(tokenId:string,userId:string){
  await prisma.$transaction(async tx=>{
    const claimed=await tx.emailVerificationToken.updateMany({where:{id:tokenId,usedAt:null,expiresAt:{gt:new Date()}},data:{usedAt:new Date()}});
    if(claimed.count!==1) throw new HttpError(400,'Verification is invalid or expired');
    await tx.user.update({where:{id:userId},data:{emailVerifiedAt:new Date()}});
  });
  await audit({actorUserId:userId,action:'EMAIL_VERIFIED',targetType:'USER',targetId:userId}).catch(()=>undefined);
}

authRouter.post('/phone-verification/request', requireAuth, asyncHandler(async (req,res)=>{
  const user=await prisma.user.findUnique({where:{id:req.auth!.userId},select:{id:true,phone:true,phoneVerifiedAt:true}});
  if(!user) throw new HttpError(404,'User not found');
  if(user.phoneVerifiedAt) return res.status(204).send();
  if(!user.phone||!/^\+[1-9]\d{7,14}$/.test(user.phone)) throw new HttpError(409,'Add a phone number in international format, for example +27821234567');
  await prisma.phoneVerificationToken.updateMany({where:{userId:user.id,usedAt:null},data:{usedAt:new Date()}});
  const code=String(randomInt(100000,1000000));
  await prisma.phoneVerificationToken.create({data:{userId:user.id,codeHash:codeHash(code),expiresAt:new Date(Date.now()+10*60*1000)}});
  const result=await sendSms({to:user.phone,body:`${code} is your SANDMAN verification code. It expires in 10 minutes. Do not share it.`,type:'VERIFY_PHONE'});
  if(!result.delivered && env.NODE_ENV==='production') throw new HttpError(503,'SMS verification is not configured');
  res.status(204).send();
}));

authRouter.post('/phone-verification/confirm', requireAuth, asyncHandler(async (req,res)=>{
  const {code}=z.object({code:z.string().regex(/^\d{6}$/)}).parse(req.body);
  const token=await prisma.phoneVerificationToken.findFirst({where:{userId:req.auth!.userId,usedAt:null,expiresAt:{gt:new Date()}},orderBy:{createdAt:'desc'}});
  if(!token||token.attempts>=6) throw new HttpError(400,'Phone verification code is invalid or expired');
  if(token.codeHash!==codeHash(code)) { await prisma.phoneVerificationToken.update({where:{id:token.id},data:{attempts:{increment:1}}}); throw new HttpError(400,'Phone verification code is invalid or expired'); }
  await prisma.$transaction([prisma.phoneVerificationToken.update({where:{id:token.id},data:{usedAt:new Date()}}),prisma.user.update({where:{id:req.auth!.userId},data:{phoneVerifiedAt:new Date()}})]);
  await audit({actorUserId:req.auth!.userId,action:'PHONE_VERIFIED',targetType:'USER',targetId:req.auth!.userId}).catch(()=>undefined);
  res.status(204).send();
}));


authRouter.post('/email-change/request', requireAuth, asyncHandler(async (req, res) => {
  const body = z.object({ newEmail: z.string().email().transform(v => v.toLowerCase()), password: z.string().min(1), code: z.string().trim().min(6).max(32).optional() }).parse(req.body);
  const user = await requireSensitiveAuth(req.auth!.userId, body.password, body.code);
  if (body.newEmail === user.email.toLowerCase()) throw new HttpError(400, 'That is already your email address');
  const existing = await prisma.user.findUnique({ where: { email: body.newEmail }, select: { id: true } });
  if (existing) throw new HttpError(409, 'That email address is already in use');
  await issueEmailChange({ id: user.id, email: user.email }, body.newEmail);
  await audit({ actorUserId:user.id, action:'EMAIL_CHANGE_REQUESTED', targetType:'USER', targetId:user.id, metadata:{ newEmail: body.newEmail } }).catch(() => undefined);
  res.status(204).send();
}));

authRouter.post('/email-change/confirm', requireAuth, asyncHandler(async (req, res) => {
  const body = z.object({ token: z.string().min(20).optional(), code: z.string().regex(/^\d{6}$/).optional() }).refine(v => Boolean(v.token || v.code), 'Token or code is required').parse(req.body);
  let change;
  if (body.token) {
    change = await prisma.emailChangeToken.findUnique({ where: { tokenHash: refreshHash(body.token) } });
  } else {
    change = await prisma.emailChangeToken.findFirst({ where: { userId:req.auth!.userId, usedAt:null, expiresAt:{gt:new Date()} }, orderBy:{createdAt:'desc'} });
    if (change && body.code && change.codeHash !== codeHash(body.code)) {
      if (change.attempts < 6) await prisma.emailChangeToken.update({ where:{id:change.id}, data:{attempts:{increment:1}} });
      throw new HttpError(400, 'Email-change code is invalid or expired');
    }
  }
  if (!change || change.userId !== req.auth!.userId || change.usedAt || change.expiresAt <= new Date() || change.attempts >= 6) throw new HttpError(400, 'Email-change request is invalid or expired');
  const current = await prisma.user.findUnique({ where:{id:req.auth!.userId}, select:{email:true} });
  if (!current) throw new HttpError(404, 'User not found');
  try {
    const updated = await prisma.$transaction(async tx => {
      const claimed = await tx.emailChangeToken.updateMany({ where:{id:change.id,usedAt:null,expiresAt:{gt:new Date()}}, data:{usedAt:new Date()} });
      if (claimed.count !== 1) throw new HttpError(400, 'Email-change request is invalid or expired');
      await tx.emailVerificationToken.updateMany({ where:{userId:req.auth!.userId,usedAt:null}, data:{usedAt:new Date()} });
      await tx.authSession.updateMany({ where:{userId:req.auth!.userId,id:{not:req.auth!.sessionId},revokedAt:null}, data:{revokedAt:new Date()} });
      return tx.user.update({ where:{id:req.auth!.userId}, data:{email:change.newEmail,emailVerifiedAt:new Date()}, select:{id:true,email:true,username:true,displayName:true,firstName:true,lastName:true,phone:true,role:true,emailVerifiedAt:true,phoneVerifiedAt:true,twoFactorEnabled:true,avatarUrl:true} });
    });
    await audit({ actorUserId:req.auth!.userId, action:'EMAIL_CHANGED', targetType:'USER', targetId:req.auth!.userId }).catch(() => undefined);
    await sendEmail({to:current.email,subject:'Your SANDMAN email was changed',text:`Your SANDMAN sign-in email was changed to ${updated.email}. If this was not you, contact support immediately.`,html:`<h2>Your email was changed</h2><p>Your SANDMAN sign-in email is now <b>${escapeHtml(updated.email)}</b>.</p><p>If this was not you, contact support immediately.</p>`,type:'SECURITY'}).catch(()=>undefined);
    res.json({ user:publicUser(updated), token:signToken(updated,req.auth!.sessionId) });
  } catch (error: any) {
    if (String(error?.code) === 'P2002') throw new HttpError(409, 'That email address is already in use');
    throw error;
  }
}));

authRouter.post('/account/export', requireAuth, asyncHandler(async (req, res) => {
  const body = z.object({ password:z.string().min(1), code:z.string().trim().min(6).max(32).optional() }).parse(req.body);
  const user = await requireSensitiveAuth(req.auth!.userId, body.password, body.code);
  const data = await prisma.user.findUnique({
    where:{id:user.id},
    select:{
      id:true,email:true,username:true,displayName:true,firstName:true,lastName:true,phone:true,country:true,bio:true,createdAt:true,updatedAt:true,emailVerifiedAt:true,phoneVerifiedAt:true,twoFactorEnabled:true,profileVisibility:true,garageVisibility:true,messagePrivacy:true,
      addresses:true,garage:{include:{vehicleVariant:{include:{model:{include:{make:true}}}}}},orders:{include:{items:true,events:true},orderBy:{createdAt:'desc'}},marketplaceProducts:{include:{images:true},orderBy:{createdAt:'desc'}},builds:{include:{items:true},orderBy:{createdAt:'desc'}},socialPosts:{orderBy:{createdAt:'desc'}},productReviews:{orderBy:{createdAt:'desc'}},notifications:{orderBy:{createdAt:'desc'}},followers:{select:{followerId:true,createdAt:true}},following:{select:{followingId:true,createdAt:true}},reportsMade:{orderBy:{createdAt:'desc'}},securityEvents:{orderBy:{createdAt:'desc'},take:200},
    },
  });
  await audit({actorUserId:user.id,action:'ACCOUNT_DATA_EXPORTED',targetType:'USER',targetId:user.id}).catch(()=>undefined);
  res.setHeader('Content-Disposition', `attachment; filename="sandman-account-${user.id}.json"`);
  res.json({ exportedAt:new Date().toISOString(), account:data });
}));

authRouter.post('/account/deactivate', requireAuth, asyncHandler(async (req, res) => {
  const body = z.object({ password:z.string().min(1), code:z.string().trim().min(6).max(32).optional(), confirm:z.literal('DELETE') }).parse(req.body);
  const user = await requireSensitiveAuth(req.auth!.userId, body.password, body.code);
  const now = new Date();
  await prisma.$transaction(async tx => {
    await tx.user.update({ where:{id:user.id}, data:{isActive:false,deletionRequestedAt:now,displayName:null,bio:null,avatarUrl:null,bannerUrl:null,phone:null,phoneVerifiedAt:null,showOnlineStatus:false} });
    await tx.socialPost.updateMany({ where:{userId:user.id,status:'PUBLISHED'}, data:{status:'REMOVED'} });
    await tx.product.updateMany({ where:{sellerId:user.id,sourceType:'MARKETPLACE',status:{in:['ACTIVE','DRAFT']}}, data:{status:'ARCHIVED'} });
    await tx.sellerProfile.updateMany({ where:{userId:user.id}, data:{verified:false,dealerVerifiedAt:null} });
    await tx.authSession.updateMany({ where:{userId:user.id,revokedAt:null}, data:{revokedAt:now} });
  });
  await audit({actorUserId:user.id,action:'ACCOUNT_DEACTIVATED',targetType:'USER',targetId:user.id}).catch(()=>undefined);
  clearRefreshCookie(res);
  res.status(204).send();
}));

authRouter.post('/change-password', requireAuth, asyncHandler(async (req, res) => {
  const data = z.object({ currentPassword: z.string().min(1), newPassword: strongPassword, code: z.string().trim().min(6).max(32).optional() }).refine(v => v.currentPassword !== v.newPassword, { message: 'New password must be different', path: ['newPassword'] }).parse(req.body);
  // Password changes are account-takeover sensitive. If 2FA is enabled, require
  // the same authenticator/recovery proof used for other sensitive settings.
  const user = await requireSensitiveAuth(req.auth!.userId, data.currentPassword, data.code);
  await prisma.$transaction([prisma.user.update({ where: { id: user.id }, data: { passwordHash: await bcrypt.hash(data.newPassword, 12) } }),prisma.authSession.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } })]);
  clearRefreshCookie(res);
  const session = await createPersistentSession(req, res, user.id, false);
  await prisma.securityEvent.create({data:{userId:user.id,type:'PASSWORD_CHANGED',ipAddress:req.ip?.slice(0,100),userAgent:req.get('user-agent')?.slice(0,500)}}).catch(()=>undefined);
  res.json({ user: publicUser(user), token: signToken(user, session.sessionId), message: 'Password changed. Other sessions were signed out.' });
}));

authRouter.get('/me', requireAuth, asyncHandler(async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.auth!.userId },
    select: { id:true,email:true,username:true,displayName:true,firstName:true,lastName:true,phone:true,role:true,createdAt:true,emailVerifiedAt:true,phoneVerifiedAt:true,twoFactorEnabled:true,avatarUrl:true,bannerUrl:true,bio:true,country:true,profileVisibility:true,garageVisibility:true,messagePrivacy:true,showFollowing:true,showOnlineStatus:true,sellerProfile:true },
  });
  if (!user) throw new HttpError(404, 'User not found');
  res.json({ ...user, emailVerified: Boolean(user.emailVerifiedAt), phoneVerified:Boolean(user.phoneVerifiedAt) });
}));

authRouter.patch('/me', requireAuth, asyncHandler(async (req, res) => {
  const body = z.object({ firstName:z.string().trim().min(1).max(80).nullable().optional(),lastName:z.string().trim().min(1).max(80).nullable().optional(),phone:z.string().trim().min(8).max(20).nullable().optional() }).parse(req.body);
  const existing=await prisma.user.findUnique({where:{id:req.auth!.userId},select:{phone:true}});
  if(!existing) throw new HttpError(404,'User not found');
  const data:any={...body};
  if(body.firstName) data.firstName=validatePersonalName(body.firstName,'First name');
  if(body.lastName) data.lastName=validatePersonalName(body.lastName,'Last name');
  if(body.phone!==undefined) {
    if(body.phone && !/^\+[1-9]\d{7,14}$/.test(body.phone)) throw new HttpError(400,'Phone number must use international format, e.g. +27821234567');
    if(body.phone!==existing.phone) data.phoneVerifiedAt=null;
  }
  const user = await prisma.user.update({ where: { id: req.auth!.userId }, data, select: { id:true,email:true,username:true,displayName:true,firstName:true,lastName:true,phone:true,role:true,createdAt:true,emailVerifiedAt:true,phoneVerifiedAt:true,twoFactorEnabled:true,avatarUrl:true } });
  res.json({ ...user, emailVerified: Boolean(user.emailVerifiedAt), phoneVerified:Boolean(user.phoneVerifiedAt) });
}));
