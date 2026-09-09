import fs from 'node:fs/promises';
import path from 'node:path';
import { prisma } from '../lib/prisma';

const MIN_READY_VARIANTS = 300;
let bootstrapPromise: Promise<VehicleCatalogBootstrapResult> | null = null;

type CuratedVehicleRow = {
  make?: unknown;
  model?: unknown;
  yearFrom?: unknown;
  yearTo?: unknown;
  yearStart?: unknown;
  yearEnd?: unknown;
  engine?: unknown;
};

type VehicleCatalogBootstrapResult = {
  skipped: boolean;
  before: number;
  after: number;
  makesCreated: number;
  modelsCreated: number;
  variantsCreated: number;
};

const clean = (value: unknown) => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
const slug = (value: string) => value
  .normalize('NFKD')
  .toLowerCase()
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 100) || 'vehicle';

async function curatedCatalogLooksReady(before: number) {
  if (before < MIN_READY_VARIANTS) return false;
  const [bmwEngine, toyota, ford] = await Promise.all([
    prisma.vehicleVariant.findFirst({
      where: {
        engineCode: { equals: 'B58', mode: 'insensitive' },
        model: {
          name: { equals: 'M140i', mode: 'insensitive' },
          make: { name: { equals: 'BMW', mode: 'insensitive' } },
        },
      },
      select: { id: true },
    }),
    prisma.vehicleVariant.findFirst({
      where: {
        model: {
          name: { equals: 'Corolla', mode: 'insensitive' },
          make: { name: { equals: 'Toyota', mode: 'insensitive' } },
        },
      },
      select: { id: true },
    }),
    prisma.vehicleVariant.findFirst({
      where: {
        model: {
          name: { equals: 'Ranger', mode: 'insensitive' },
          make: { name: { equals: 'Ford', mode: 'insensitive' } },
        },
      },
      select: { id: true },
    }),
  ]);
  return Boolean(bmwEngine && toyota && ford);
}

async function runBootstrap(): Promise<VehicleCatalogBootstrapResult> {
  const before = await prisma.vehicleVariant.count();
  if (await curatedCatalogLooksReady(before)) {
    return { skipped: true, before, after: before, makesCreated: 0, modelsCreated: 0, variantsCreated: 0 };
  }

  const filePath = path.join(process.cwd(), 'data', 'sandman-global-vehicles.json');
  const parsed = JSON.parse(await fs.readFile(filePath, 'utf8')) as { records?: CuratedVehicleRow[] };
  const records = Array.isArray(parsed.records) ? parsed.records : [];
  let makesCreated = 0;
  let modelsCreated = 0;
  let variantsCreated = 0;

  for (const row of records) {
    const makeName = clean(row.make);
    const modelName = clean(row.model);
    const yearStart = Number(row.yearFrom ?? row.yearStart);
    const yearEnd = Number(row.yearTo ?? row.yearEnd ?? yearStart);
    const curatedEngine = clean(row.engine);
    const engineCode = curatedEngine || 'UNSPECIFIED';
    const engineName = curatedEngine || 'Multiple / unspecified engines';
    if (!makeName || !modelName || !Number.isInteger(yearStart) || !Number.isInteger(yearEnd) || yearStart < 1886 || yearEnd > 2200 || yearEnd < yearStart) continue;

    const makeSlug = slug(makeName);
    let make = await prisma.vehicleMake.findFirst({
      where: { OR: [{ name: { equals: makeName, mode: 'insensitive' } }, { slug: makeSlug }] },
    });
    if (!make) {
      make = await prisma.vehicleMake.create({ data: { name: makeName, slug: makeSlug } });
      makesCreated++;
    }

    const modelSlug = slug(modelName);
    let model = await prisma.vehicleModel.findFirst({
      where: { makeId: make.id, OR: [{ name: { equals: modelName, mode: 'insensitive' } }, { slug: modelSlug }] },
    });
    if (!model) {
      model = await prisma.vehicleModel.create({ data: { makeId: make.id, name: modelName, slug: modelSlug } });
      modelsCreated++;
    }

    const existing = await prisma.vehicleVariant.findFirst({
      where: {
        modelId: model.id,
        yearStart,
        yearEnd,
        engineCode: { equals: engineCode, mode: 'insensitive' },
      },
      select: { id: true },
    });
    if (!existing) {
      await prisma.vehicleVariant.create({
        data: { modelId: model.id, yearStart, yearEnd, engineCode, engineName },
      });
      variantsCreated++;
    }
  }

  const after = await prisma.vehicleVariant.count();
  return { skipped: false, before, after, makesCreated, modelsCreated, variantsCreated };
}

/**
 * Ensures production has a useful offline vehicle catalogue before supplier
 * synchronization starts. It is idempotent, preserves curated engine values
 * such as B58/N55, and re-runs when a large supplier-created table exists but
 * the bundled curated catalogue is not actually present.
 */
export function ensureCuratedVehicleCatalog() {
  if (!bootstrapPromise) {
    bootstrapPromise = runBootstrap().catch(error => {
      bootstrapPromise = null;
      throw error;
    });
  }
  return bootstrapPromise;
}
