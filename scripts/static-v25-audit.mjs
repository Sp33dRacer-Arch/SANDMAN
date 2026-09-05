import fs from 'node:fs';
import path from 'node:path';
const root=process.cwd();
const read=rel=>fs.readFileSync(path.join(root,rel),'utf8');
let failed=false;
const pass=m=>console.log(`PASS: ${m}`);
const fail=m=>{failed=true;console.error(`V2.5 AUDIT FAILED: ${m}`)};
const store=read('public/store/app.js');
const admin=read('public/admin/app.js');
const adminHtml=read('public/admin/index.html');
const schema=read('prisma/schema.prisma');
const migration=read('prisma/migrations/20260905101500_v25_global_commerce_customer_intelligence/migration.sql');
const orders=read('src/modules/orders/orders.routes.ts');
const commerce=read('src/services/global-commerce.service.ts');
const readiness=read('src/modules/admin/readiness.routes.ts');
const customer=read('src/modules/admin/customer-intelligence.routes.ts');
const env=read('src/config/env.ts');
const app=read('src/app.ts');
const pkg=JSON.parse(read('package.json'));
const required=[
 [schema,'enum FitmentCompatibility','explicit fitment compatibility enum'],
 [schema,'compatibility    FitmentCompatibility','fitment compatibility persisted'],
 [migration,"CREATE TYPE \"FitmentCompatibility\" AS ENUM ('FITS', 'DOES_NOT_FIT')",'negative-fit migration'],
 [orders,'acknowledgedUnknownFitmentProductIds','unknown-fitment acknowledgement'],
 [orders,'UNKNOWN_FITMENT_ACK_REQUIRED','unknown-fitment checkout gate'],
 [commerce,'restrictedCountries','restricted-country enforcement'],
 [commerce,'taxableProductsCents','non-taxable product exclusion'],
 [commerce,'taxRule.taxInclusive','tax-inclusive handling'],
 [commerce,'No shipping rate is configured','fail-safe unknown shipping'],
 [commerce,'Tax calculation is not configured','fail-safe tax configuration'],
 [commerce,'DUTY_CALCULATION_WEBHOOK_URL','duty-provider integration'],
 [commerce,'allowedPaymentProviders','regional payment enforcement'],
 [store,'SANDMAN Verified Fit','Verified Fit storefront'],
 [store,'fitmentEvidenceHtml','fitment evidence UI'],
 [store,'fitOnlyFilter','fit-only shop control'],
 [store,"currentFitStatus==='DOES_NOT_FIT'",'known-incompatible purchase blocking'],
 [store,'cookieConsent','cookie/privacy consent'],
 [admin,'renderCustomerIntelligence','Customer 360 admin'],
 [admin,'openCustomer360','Customer 360 detail view'],
 [admin,'renderCommerce','Global Commerce admin'],
 [admin,'renderReadiness','Launch Readiness admin'],
 [adminHtml,'data-view="customers"','Customer Intelligence nav'],
 [adminHtml,'data-view="commerce"','Global Commerce nav'],
 [adminHtml,'data-view="readiness"','Launch Readiness nav'],
 [readiness,'check.mode === \'AUTOMATIC\'','automatic readiness override protection'],
 [readiness,"requireRole('ADMIN')",'admin-only readiness updates'],
 [customer,'requireRole(\'ADMIN\', \'STAFF\')','Customer Intelligence access control'],
 [customer,'maskedVin','masked VIN in Customer 360'],
 [env,'ERROR_MONITORING_WEBHOOK_URL','error monitoring configuration'],
 [env,'READ_REPLICA_DATABASE_URL','read replica configuration'],
 [app,"version: '2.5.0'",'API version 2.5.0'],
];
for(const [src,needle,label] of required) src.includes(needle)?pass(label):fail(`${label} missing`);
if(pkg.version==='2.5.0') pass('package version 2.5.0'); else fail(`package version ${pkg.version}`);
if(store.includes("p.fitmentStatus||'CATALOG_FIT'")) fail('missing fitment still defaults to Catalogue Fit'); else pass('missing fitment remains unknown');
if(/DROP TABLE|TRUNCATE|DELETE FROM|DROP COLUMN/i.test(migration)) fail('destructive SQL found in V2.5 migration'); else pass('V2.5 migration has no obvious destructive SQL');
for(const forbidden of ['eval(', 'new Function(']) { if(store.includes(forbidden)||admin.includes(forbidden)) fail(`browser dynamic-code primitive: ${forbidden}`); }
if(!failed) console.log('SANDMAN V2.5 static audit passed.');
process.exit(failed?1:0);
