import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const fail = message => { console.error(`STATIC AUDIT FAILED: ${message}`); process.exitCode = 1; };
const pass = message => console.log(`PASS: ${message}`);

const store = read('public/store/app.js');
const admin = read('public/admin/app.js');
const storeCss = read('public/store/styles.css');
const adminCss = read('public/admin/styles.css');
const index = read('public/store/index.html');
const auth = read('src/modules/auth/auth.routes.ts');
const security = read('src/modules/security/security.routes.ts');
const app = read('src/app.ts');
const uploads = read('src/modules/uploads/uploads.routes.ts');
const envConfig = read('src/config/env.ts');
const schema = read('prisma/schema.prisma');
const pkg = JSON.parse(read('package.json'));

// Catch the exact class of runtime defect that slipped through node --check:
// a route calls renderSomething(), but no function declaration exists.
const calledRenders = new Set([...store.matchAll(/\b(render[A-Z][A-Za-z0-9_]*)\s*\(/g)].map(m => m[1]));
const declaredRenders = new Set([
  ...[...store.matchAll(/\b(?:async\s+)?function\s+(render[A-Z][A-Za-z0-9_]*)\s*\(/g)].map(m => m[1]),
  ...[...store.matchAll(/\b(?:const|let|var)\s+(render[A-Z][A-Za-z0-9_]*)\s*=/g)].map(m => m[1]),
]);
const missingRenders = [...calledRenders].filter(name => !declaredRenders.has(name));
if (missingRenders.length) fail(`undefined storefront render functions: ${missingRenders.join(', ')}`);
else pass(`${calledRenders.size} storefront render routes resolve to declared functions`);

for (const name of ['renderVehicleFinder','renderAdvisor','renderRequests','renderSecurityPanel']) {
  if (!declaredRenders.has(name)) fail(`${name} is missing`);
}

if (!security.includes('QRCode.toDataURL')) fail('2FA setup does not generate a QR code');
else pass('2FA QR setup is present');
if (/otpauth:\/\/[^`'"\n]*\$\{?/.test(store)) fail('raw otpauth URI appears in storefront UI source');
else pass('raw otpauth URI is not rendered by the storefront');
if (!security.includes('twoFactorPendingSecretEnc') || !security.includes("'/2fa/enable'")) fail('2FA pending-secret confirmation flow is incomplete');
else pass('2FA remains pending until the first code is verified');
if (!auth.includes('requireSensitiveAuth(req.auth!.userId, data.currentPassword, data.code)')) fail('password changes do not require second factor when enabled');
else pass('password change uses sensitive-auth/2FA gate');
if (!app.includes("app.use('/api/auth/register', registerLimiter)")) fail('registration-specific rate limiter is missing');
else pass('registration endpoint has a dedicated rate limit');
if (!uploads.includes("Verify your email before uploading images")) fail('upload signatures are available before email verification');
else pass('image upload signatures require a verified email');
if (!envConfig.includes('TOTP_ENCRYPTION_KEY')) fail('separate TOTP encryption key is not configurable');
else pass('separate TOTP encryption key is configurable');
const resetModel = schema.match(/model PasswordResetToken\s*\{([\s\S]*?)\n\}/)?.[1] || '';
if (/\b(codeHash|attempts)\b/.test(resetModel)) fail('PasswordResetToken contains fields not shipped by the V2.4 migration');
else pass('PasswordResetToken schema matches the shipped migration');

if (!index.includes('viewport-fit=cover')) fail('mobile safe-area viewport support missing');
else pass('mobile viewport safe-area support present');
if (!/@media\(max-width:640px\)[\s\S]*?input,select,textarea\{font-size:16px\}/.test(storeCss)) fail('mobile inputs do not enforce 16px sizing');
else pass('mobile inputs prevent iOS focus zoom');
if (!storeCss.includes('min-height:44px') || !adminCss.includes('min-height:44px')) fail('44px touch targets missing from store or admin');
else pass('44px mobile touch targets present in store and admin');
if (!storeCss.includes(':root[data-theme="light"]')) fail('storefront light-theme overrides missing');
else pass('light-theme overrides present');

if (pkg.version !== '2.4.1') fail(`package version is ${pkg.version}, expected 2.4.1`);
if (!app.includes("version: '2.4.1'")) fail('API root version marker is stale');
else pass('runtime version markers are current');

for (const forbidden of ['eval(', 'new Function(']) {
  if (store.includes(forbidden) || admin.includes(forbidden)) fail(`dangerous browser execution primitive found: ${forbidden}`);
}
if (!process.exitCode) pass('no obvious dynamic-code execution primitive in browser bundles');

if (process.exitCode) process.exit(process.exitCode);
console.log('SANDMAN V2.4.1 static UI/security audit passed.');
