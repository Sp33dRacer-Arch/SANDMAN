import { Router } from 'express';
import { z } from 'zod';
import { prisma, readReplicaConfigured } from '../../lib/prisma';
import { asyncHandler } from '../../lib/async-handler';
import { routeParam } from '../../lib/route-param';
import { requireAuth, requireRole } from '../../middleware/auth';
import { env } from '../../config/env';
import { audit } from '../../services/audit.service';

export const readinessRouter = Router();
readinessRouter.use(requireAuth, requireRole('ADMIN', 'STAFF'));

type Status = 'NOT_STARTED' | 'NEEDS_CONFIGURATION' | 'NEEDS_TEST' | 'PASS' | 'FAIL' | 'NOT_APPLICABLE';
type Check = {
  key: string;
  category: string;
  label: string;
  status: Status;
  detail: string;
  mode: 'AUTOMATIC' | 'CERTIFICATION' | 'MANUAL';
  note?: string | null;
  checkedAt?: Date | null;
};

const configured = (...values: unknown[]) => values.every(value => typeof value === 'string' ? value.trim().length > 0 : Boolean(value));
const jsonStrings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

async function liveUrlCheck(url: string) {
  try {
    const response = await fetch(new URL('/api/health', url), { signal: AbortSignal.timeout(4_000), redirect: 'follow' });
    return response.ok;
  } catch {
    return false;
  }
}

function mergeCheck(check: Check, saved: Awaited<ReturnType<typeof prisma.operationalReadiness.findMany>>[number] | undefined): Check {
  if (!saved) return check;
  const savedStatus = saved.status as Status;

  // Automatic checks are always authoritative. A person cannot type PASS over
  // a failing database/domain/configuration check.
  if (check.mode === 'AUTOMATIC') return { ...check, note: saved.note, checkedAt: saved.checkedAt };

  // Certification checks may become PASS only after the underlying integration
  // is at least configured. A manual PASS cannot hide missing configuration.
  if (check.mode === 'CERTIFICATION' && ['NEEDS_CONFIGURATION', 'FAIL'].includes(check.status)) {
    return { ...check, note: saved.note, checkedAt: saved.checkedAt };
  }

  return { ...check, status: savedStatus, note: saved.note, checkedAt: saved.checkedAt };
}

readinessRouter.get('/', asyncHandler(async (_req, res) => {
  let databaseOk = false;
  let databaseSizeBytes: number | null = null;
  try {
    await prisma.$queryRaw`SELECT 1`;
    databaseOk = true;
    const rows = await prisma.$queryRaw<Array<{ bytes: bigint }>>`SELECT pg_database_size(current_database()) AS bytes`;
    databaseSizeBytes = rows[0]?.bytes != null ? Number(rows[0].bytes) : null;
  } catch {}

  const [
    savedRows, suppliers, regions, taxRules, zones, fxRates,
  ] = await Promise.all([
    prisma.operationalReadiness.findMany(),
    prisma.supplier.findMany({ where: { active: true }, select: { id: true, type: true, name: true } }),
    prisma.commerceRegion.findMany({ orderBy: { country: 'asc' } }),
    prisma.taxRule.findMany({ where: { active: true }, select: { country: true, region: true } }),
    prisma.shippingZone.findMany({ where: { active: true }, select: { id: true, name: true, countries: true } }),
    prisma.fxRate.findMany({ where: { baseCurrency: env.CURRENCY.toUpperCase() }, select: { quoteCurrency: true, fetchedAt: true } }),
  ]);
  const saved = new Map(savedRows.map(row => [row.key, row]));

  const appUrl = new URL(env.APP_URL);
  const customHost = appUrl.protocol === 'https:' && !appUrl.hostname.includes('railway.app') && !['localhost', '127.0.0.1'].includes(appUrl.hostname);
  const customDomainLive = customHost ? await liveUrlCheck(env.APP_URL) : false;

  const allowedRegions = regions.filter(region => region.shippingAllowed);
  const zoneCoverage = new Set<string>();
  let wildcardZone = false;
  for (const zone of zones) {
    for (const code of jsonStrings(zone.countries).map(code => code.toUpperCase())) {
      if (code === '*') wildcardZone = true;
      else zoneCoverage.add(code);
    }
  }
  const uncoveredShippingCountries = allowedRegions
    .map(region => region.country)
    .filter(country => !wildcardZone && !zoneCoverage.has(country));
  const taxCountries = new Set(taxRules.map(rule => rule.country.toUpperCase()));
  const missingTaxCountries = regions
    .filter(region => region.shippingAllowed && region.taxRequired)
    .map(region => region.country)
    .filter(country => !taxCountries.has(country));
  const fxCurrencies = new Set(fxRates.map(rate => rate.quoteCurrency.toUpperCase()));
  const missingFxCurrencies = [...new Set(regions.map(region => region.currency.toUpperCase()))]
    .filter(currency => currency !== env.CURRENCY.toUpperCase() && !fxCurrencies.has(currency));
  const dutiesCountries = regions.filter(region => region.shippingAllowed && region.dutiesRequired).map(region => region.country);
  const nonMockSuppliers = suppliers.filter(supplier => supplier.type !== 'MOCK');
  const realEmailFrom = Boolean(env.EMAIL_FROM && !env.EMAIL_FROM.toLowerCase().endsWith('@sandman.local'));

  const checks: Check[] = [
    { key:'DATABASE_HEALTH', category:'Core', label:'PostgreSQL connection', status:databaseOk?'PASS':'FAIL', detail:databaseOk?'Database query succeeded':'Database query failed', mode:'AUTOMATIC' },
    { key:'CUSTOM_DOMAIN', category:'Core', label:'Custom domain + HTTPS', status:customDomainLive?'PASS':customHost?'FAIL':'NEEDS_CONFIGURATION', detail:customDomainLive?`${env.APP_URL} responded over HTTPS`:customHost?'Custom domain is configured but its live health check failed':'APP_URL is not using an active custom HTTPS hostname', mode:'AUTOMATIC' },

    { key:'STRIPE_E2E', category:'Commerce', label:'Stripe end-to-end', status:configured(env.STRIPE_SECRET_KEY,env.STRIPE_PUBLISHABLE_KEY,env.STRIPE_WEBHOOK_SECRET)?'NEEDS_TEST':'NEEDS_CONFIGURATION', detail:'Test successful/declined payment, signed webhook idempotency and refund.', mode:'CERTIFICATION' },
    { key:'PAYPAL_E2E', category:'Commerce', label:'PayPal end-to-end', status:configured(env.PAYPAL_CLIENT_ID,env.PAYPAL_CLIENT_SECRET)?'NEEDS_TEST':'NEEDS_CONFIGURATION', detail:`Mode: ${env.PAYPAL_MODE}. Test create/capture/cancel/refund if PayPal will be offered.`, mode:'CERTIFICATION' },
    { key:'SUPPLIER_FULFILLMENT_E2E', category:'Commerce', label:'Real supplier fulfillment', status:nonMockSuppliers.length?'NEEDS_TEST':'NEEDS_CONFIGURATION', detail:`${nonMockSuppliers.length} non-mock supplier(s). Test paid order → supplier → tracking → delivery/cancellation.`, mode:'CERTIFICATION' },

    { key:'CLOUDINARY_LIVE', category:'Identity & Media', label:'Cloudinary production upload', status:configured(env.CLOUDINARY_CLOUD_NAME,env.CLOUDINARY_API_KEY,env.CLOUDINARY_API_SECRET)?'NEEDS_TEST':'NEEDS_CONFIGURATION', detail:'Test a signed upload using a verified production-like account.', mode:'CERTIFICATION' },
    { key:'MODERATION_LIVE', category:'Identity & Media', label:'Sightengine/moderation bridge', status:configured(env.CONTENT_MODERATION_WEBHOOK_URL,env.CONTENT_MODERATION_WEBHOOK_SECRET)?'NEEDS_TEST':'NEEDS_CONFIGURATION', detail:'Test safe image, blocked image and provider failure/fail-closed behavior.', mode:'CERTIFICATION' },
    { key:'RESEND_LIVE', category:'Identity & Media', label:'Resend sender domain + email', status:configured(env.RESEND_API_KEY)&&realEmailFrom?'NEEDS_TEST':'NEEDS_CONFIGURATION', detail:realEmailFrom?`Sender ${env.EMAIL_FROM}. Verify sender domain and test verification/reset delivery.`:'EMAIL_FROM still uses the local placeholder or Resend is not configured.', mode:'CERTIFICATION' },
    { key:'TWILIO_LIVE', category:'Identity & Media', label:'Twilio OTP', status:configured(env.TWILIO_ACCOUNT_SID,env.TWILIO_AUTH_TOKEN,env.TWILIO_FROM_NUMBER)?'NEEDS_TEST':'NEEDS_CONFIGURATION', detail:'Test send, correct code, wrong code, expiry and throttling.', mode:'CERTIFICATION' },

    { key:'REGIONAL_COMMERCE', category:'Global Commerce', label:'Commerce regions', status:regions.length&&allowedRegions.length?'PASS':'NEEDS_CONFIGURATION', detail:`${regions.length} region(s), ${allowedRegions.length} enabled for shipping.`, mode:'AUTOMATIC' },
    { key:'WORLDWIDE_SHIPPING', category:'Global Commerce', label:'Shipping coverage', status:!allowedRegions.length?'NEEDS_CONFIGURATION':env.CARRIER_RATE_WEBHOOK_URL?'NEEDS_TEST':uncoveredShippingCountries.length?'NEEDS_CONFIGURATION':'PASS', detail:env.CARRIER_RATE_WEBHOOK_URL?'Carrier-rate webhook configured; live quote must pass.':uncoveredShippingCountries.length?`Missing zone coverage: ${uncoveredShippingCountries.join(', ')}`:`All enabled commerce countries are covered by shipping zones.`, mode:env.CARRIER_RATE_WEBHOOK_URL?'CERTIFICATION':'AUTOMATIC' },
    { key:'TAX_ENGINE', category:'Global Commerce', label:'Country/region tax rules', status:!regions.length?'NEEDS_CONFIGURATION':missingTaxCountries.length?'NEEDS_CONFIGURATION':'PASS', detail:missingTaxCountries.length?`Missing required country tax rules: ${missingTaxCountries.join(', ')}`:'Every tax-required enabled commerce country has a tax rule.', mode:'AUTOMATIC' },
    { key:'FX_RATES', category:'Global Commerce', label:'Display currencies + FX', status:missingFxCurrencies.length?'NEEDS_CONFIGURATION':'PASS', detail:missingFxCurrencies.length?`Missing ${env.CURRENCY.toUpperCase()} FX rates for: ${missingFxCurrencies.join(', ')}`:`${fxRates.length} display FX rate(s) available. Settlement stays ${env.CURRENCY.toUpperCase()}.`, mode:'AUTOMATIC' },
    { key:'DUTIES', category:'Global Commerce', label:'Duties / landed-cost calculation', status:!dutiesCountries.length?'NOT_APPLICABLE':env.DUTY_CALCULATION_WEBHOOK_URL?'NEEDS_TEST':'NEEDS_CONFIGURATION', detail:!dutiesCountries.length?'No enabled commerce region currently requires duty calculation.':env.DUTY_CALCULATION_WEBHOOK_URL?`Duty provider required for ${dutiesCountries.join(', ')}; live quote still needs testing.`:`Duty calculation required for ${dutiesCountries.join(', ')} but no provider is configured.`, mode:dutiesCountries.length?'CERTIFICATION':'AUTOMATIC' },

    { key:'COOKIE_PRIVACY', category:'Privacy & Legal', label:'Cookie/privacy consent', status:'PASS', detail:'Necessary, analytics, preferences and marketing consent categories are installed.', mode:'AUTOMATIC' },
    { key:'LEGAL_REVIEW', category:'Privacy & Legal', label:'Final legal policies reviewed', status:'NEEDS_TEST', detail:'Operational policy drafts exist; jurisdiction-specific legal review is still required.', mode:'MANUAL' },

    { key:'E2E_BROWSER', category:'Quality', label:'Desktop + mobile browser E2E', status:'NEEDS_TEST', detail:'Playwright V2.5 suite is included. Run it against the deployed environment.', mode:'MANUAL' },

    { key:'ERROR_MONITORING', category:'Observability', label:'Error monitoring', status:env.ERROR_MONITORING_WEBHOOK_URL?'NEEDS_TEST':'NEEDS_CONFIGURATION', detail:env.ERROR_MONITORING_WEBHOOK_URL?'Error-monitoring webhook configured; trigger/capture a controlled test error.':'No external error-monitoring webhook configured.', mode:'CERTIFICATION' },
    { key:'UPTIME_MONITORING', category:'Observability', label:'External uptime monitoring', status:env.UPTIME_MONITOR_URL?'NEEDS_TEST':'NEEDS_CONFIGURATION', detail:env.UPTIME_MONITOR_URL?'External monitor URL recorded; confirm outage alert delivery.':'No external uptime monitor recorded.', mode:'CERTIFICATION' },
    { key:'ANALYTICS', category:'Observability', label:'Consent-aware commerce analytics', status:'PASS', detail:'First-party funnel events, retention tooling and optional marketing/warehouse forwarding are installed.', mode:'AUTOMATIC' },

    { key:'PRODUCTION_BACKUPS', category:'Database Recovery', label:'Automated production backups confirmed', status:'NEEDS_TEST', detail:'Confirm provider backup schedule and retention with evidence.', mode:'MANUAL' },
    { key:'PITR', category:'Database Recovery', label:'Point-in-time recovery confirmed', status:'NEEDS_TEST', detail:'Confirm PITR availability and recovery window on the production database plan.', mode:'MANUAL' },
    { key:'RESTORE_DRILL', category:'Database Recovery', label:'Database restore drill', status:'NEEDS_TEST', detail:'Restore a recent production backup into a non-production database and verify it.', mode:'MANUAL' },
    { key:'DATA_ARCHIVE_POLICY', category:'Database Recovery', label:'Data archive/retention policy', status:'NEEDS_TEST', detail:'V2.5 retention runbook exists; approve business/legal retention periods.', mode:'MANUAL' },
    { key:'DATABASE_GROWTH_ALERTS', category:'Database Recovery', label:'Database growth alerts', status:configured(env.DB_STORAGE_ALERT_THRESHOLD_MB,env.DB_STORAGE_ALERT_WEBHOOK_URL)?'NEEDS_TEST':'NEEDS_CONFIGURATION', detail:`Current DB size: ${databaseSizeBytes==null?'unknown':`${(databaseSizeBytes/1024/1024).toFixed(1)} MB`}. Configure threshold + alert webhook, then test it.`, mode:'CERTIFICATION' },
    { key:'READ_REPLICA', category:'Scale', label:'Read replica strategy', status:readReplicaConfigured?'NEEDS_TEST':'NOT_APPLICABLE', detail:readReplicaConfigured?'Read replica URL is configured; validate lag/failover for analytics/CRM reads.':'Primary database is used for reads until read-heavy scale justifies a replica.', mode:readReplicaConfigured?'CERTIFICATION':'AUTOMATIC' },
    { key:'ANALYTICS_WAREHOUSE', category:'Scale', label:'Analytics warehouse/export', status:env.ANALYTICS_WAREHOUSE_URL?'NEEDS_TEST':'NOT_APPLICABLE', detail:env.ANALYTICS_WAREHOUSE_URL?'Warehouse endpoint configured; run and verify the exporter.':'PostgreSQL remains the analytics store until warehouse scale is needed.', mode:env.ANALYTICS_WAREHOUSE_URL?'CERTIFICATION':'AUTOMATIC' },
  ];

  const merged = checks.map(check => mergeCheck(check, saved.get(check.key)));
  const scoreChecks = merged.filter(check => check.status !== 'NOT_APPLICABLE');
  const score = scoreChecks.length
    ? Math.round(scoreChecks.reduce((sum, check) => sum + (check.status === 'PASS' ? 1 : check.status === 'NEEDS_TEST' ? 0.5 : 0), 0) / scoreChecks.length * 100)
    : 0;

  res.json({ score, databaseSizeBytes, checks: merged });
}));

readinessRouter.put('/:key', requireRole('ADMIN'), asyncHandler(async (req, res) => {
  const key = routeParam(req.params.key, 'key').toUpperCase();
  const data = z.object({
    status: z.enum(['NOT_STARTED','NEEDS_CONFIGURATION','NEEDS_TEST','PASS','FAIL','NOT_APPLICABLE']),
    note: z.string().trim().max(2000).optional(),
    evidence: z.record(z.string(), z.union([z.string().max(1000),z.number().finite(),z.boolean(),z.null()])).optional(),
  }).parse(req.body);
  const record = await prisma.operationalReadiness.upsert({
    where: { key },
    update: { ...data, checkedAt: new Date(), checkedByUserId: req.auth!.userId },
    create: { key, ...data, checkedAt: new Date(), checkedByUserId: req.auth!.userId },
  });
  await audit({ actorUserId: req.auth!.userId, action:'READINESS_UPDATED', targetType:'READINESS', targetId:key, metadata:{ status:data.status } });
  res.json(record);
}));
