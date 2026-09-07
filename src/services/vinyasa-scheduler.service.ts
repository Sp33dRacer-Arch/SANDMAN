import { env } from '../config/env';
import { prisma } from '../lib/prisma';
import { acquireVinyasaSyncLease, ensureVinyasaSupplier, releaseVinyasaSyncLease, resumeVinyasaImportJob, syncVinyasaCatalog, syncVinyasaTracking } from './vinyasa.service';

let timer: NodeJS.Timeout | null = null;
let stopped = false;

async function runScheduledSync() {
  if (stopped || !env.VINYASA_API_KEY) return;
  const { config } = await ensureVinyasaSupplier();
  if (!config.autoSyncEnabled) return;
  const now = Date.now();
  if (config.lastSyncAt && now - config.lastSyncAt.getTime() < config.syncIntervalMinutes * 60_000) return;
  const owner = await acquireVinyasaSyncLease();
  if (!owner) return;
  try {
    await syncVinyasaCatalog({ mode: 'STOCK_PRICE', leaseOwner: owner });
    await syncVinyasaTracking().catch(error => console.error('Scheduled Vinyasa tracking sync failed', error));
  } catch (error) {
    console.error('Scheduled Vinyasa sync failed', error);
  } finally {
    await releaseVinyasaSyncLease(owner).catch(() => undefined);
  }
}

export function startVinyasaScheduler() {
  if (timer || !env.VINYASA_API_KEY) return;
  stopped = false;
  void ensureVinyasaSupplier().then(({ config }) => {
    if (config.importJobStatus === 'RUNNING') return resumeVinyasaImportJob();
    return undefined;
  }).catch(error => console.error('Vinyasa import resume failed', error));
  void runScheduledSync();
  timer = setInterval(() => void runScheduledSync(), 60_000);
}

export async function stopVinyasaScheduler() {
  stopped = true;
  if (timer) clearInterval(timer);
  timer = null;
  // Best-effort cleanup of stale leases owned by a process that is shutting down.
  const supplier = await prisma.supplier.findUnique({ where: { code: 'vinyasa' }, select: { id: true } }).catch(() => null);
  if (supplier) await prisma.supplierIntegrationConfig.updateMany({ where: { supplierId: supplier.id, syncLeaseUntil: { lt: new Date(Date.now() + 2 * 60_000) } }, data: { syncLeaseUntil: null, syncLeaseOwner: null } }).catch(() => undefined);
}
