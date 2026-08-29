import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const demoImage = (label: string) => `https://placehold.co/1200x900/0a0a0a/e8d9c6?text=${encodeURIComponent(label)}`;

async function main() {
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_DEMO_SEED !== 'true') {
    throw new Error('Refusing to seed demo accounts/data in production. Set ALLOW_DEMO_SEED=true only if you intentionally want the demo seed.');
  }

  const adminPassword = await bcrypt.hash('SandmanAdmin123!', 12);
  await prisma.user.upsert({
    where: { email: 'admin@sandman.local' },
    update: {},
    create: {
      email: 'admin@sandman.local',
      passwordHash: adminPassword,
      firstName: 'SANDMAN',
      lastName: 'Admin',
      role: 'ADMIN',
      cart: { create: {} },
    },
  });

  const sellerPassword = await bcrypt.hash('SellerDemo123!', 12);
  const demoSeller = await prisma.user.upsert({
    where: { email: 'seller@sandman.local' },
    update: {},
    create: {
      email: 'seller@sandman.local',
      passwordHash: sellerPassword,
      firstName: 'Mason',
      lastName: 'Reed',
      role: 'CUSTOMER',
      cart: { create: {} },
    },
  });

  await prisma.sellerProfile.upsert({
    where: { userId: demoSeller.id },
    update: { storeName: 'Nightshift Performance', bio: 'Demo verified marketplace seller for SANDMAN development and testing.', location: 'South Africa', responseTimeHours: 4 },
    create: { userId: demoSeller.id, storeName: 'Nightshift Performance', bio: 'Demo verified marketplace seller for SANDMAN development and testing.', location: 'South Africa', verified: true, responseTimeHours: 4 },
  });

  const categoryDefs = [
    ['Air & Intake', 'air-intake'],
    ['Cooling', 'cooling'],
    ['Ignition', 'ignition'],
    ['Turbo & Boost', 'turbo-boost'],
    ['Fuel System', 'fuel-system'],
    ['Gaskets & Seals', 'gaskets-seals'],
    ['Engine Mounts', 'engine-mounts'],
    ['Engine Components', 'engine-components'],
    ['Exhaust', 'exhaust'],
    ['Electronics & Sensors', 'electronics-sensors'],
    ['Drivetrain', 'drivetrain'],
  ] as const;

  const categories = await Promise.all(categoryDefs.map(([name, slug]) => prisma.category.upsert({
    where: { slug }, update: {}, create: { name, slug },
  })));
  const category = (slug: string) => categories.find(c => c.slug === slug)!;

  const bmw = await prisma.vehicleMake.upsert({ where: { slug: 'bmw' }, update: {}, create: { name: 'BMW', slug: 'bmw' } });
  const toyota = await prisma.vehicleMake.upsert({ where: { slug: 'toyota' }, update: {}, create: { name: 'Toyota', slug: 'toyota' } });
  const vw = await prisma.vehicleMake.upsert({ where: { slug: 'volkswagen' }, update: {}, create: { name: 'Volkswagen', slug: 'volkswagen' } });

  const bmw340 = await prisma.vehicleModel.upsert({
    where: { makeId_slug: { makeId: bmw.id, slug: '3-series-340i' } },
    update: {}, create: { makeId: bmw.id, name: '3 Series 340i', slug: '3-series-340i' },
  });
  const supra = await prisma.vehicleModel.upsert({
    where: { makeId_slug: { makeId: toyota.id, slug: 'gr-supra' } },
    update: {}, create: { makeId: toyota.id, name: 'GR Supra', slug: 'gr-supra' },
  });
  const golf = await prisma.vehicleModel.upsert({
    where: { makeId_slug: { makeId: vw.id, slug: 'golf-gti' } },
    update: {}, create: { makeId: vw.id, name: 'Golf GTI', slug: 'golf-gti' },
  });

  const b58Bmw = await prisma.vehicleVariant.findFirst({ where: { modelId: bmw340.id, engineCode: 'B58B30M0' } }) ?? await prisma.vehicleVariant.create({
    data: { modelId: bmw340.id, yearStart: 2016, yearEnd: 2019, trim: '340i', chassisCode: 'F30/F31', engineCode: 'B58B30M0', engineName: 'B58 3.0L Turbo Inline-6', displacementCc: 2998, aspiration: 'Turbocharged', fuelType: 'Petrol', drivetrain: 'RWD/AWD' },
  });
  const b58Supra = await prisma.vehicleVariant.findFirst({ where: { modelId: supra.id, engineCode: 'B58B30C' } }) ?? await prisma.vehicleVariant.create({
    data: { modelId: supra.id, yearStart: 2020, yearEnd: 2026, trim: '3.0', chassisCode: 'A90/A91', engineCode: 'B58B30C', engineName: 'B58 3.0L Turbo Inline-6', displacementCc: 2998, aspiration: 'Turbocharged', fuelType: 'Petrol', drivetrain: 'RWD' },
  });
  const ea888 = await prisma.vehicleVariant.findFirst({ where: { modelId: golf.id, engineCode: 'EA888 Gen 3' } }) ?? await prisma.vehicleVariant.create({
    data: { modelId: golf.id, yearStart: 2015, yearEnd: 2021, trim: 'GTI', chassisCode: 'MK7/MK7.5', engineCode: 'EA888 Gen 3', engineName: 'EA888 2.0L Turbo Inline-4', displacementCc: 1984, aspiration: 'Turbocharged', fuelType: 'Petrol', drivetrain: 'FWD' },
  });

  const mockSupplier = await prisma.supplier.upsert({
    where: { code: 'mock' }, update: {},
    create: { name: 'SANDMAN Sandbox Supplier', code: 'mock', type: 'MOCK', priority: 1 },
  });

  await prisma.supplier.upsert({
    where: { code: 'syncee' },
    update: { type: 'SYNCEE', active: true },
    create: { name: 'Syncee', code: 'syncee', type: 'SYNCEE', priority: 25, baseUrl: 'https://syncee.com' },
  });

  const dropshipDefs = [
    { sku: 'SM-B58-INT-001', slug: 'b58-performance-cold-air-intake', name: 'B58 Performance Cold Air Intake', brand: 'SANDMAN Performance', category: 'air-intake', price: 29999, compare: 34999, cost: 14500, ship: 2500, supplierId: 'MOCK-B58-INTAKE', desc: 'High-flow intake system for selected B58-powered vehicles. Supplier-stocked and routed through SANDMAN fulfillment.', fitments: [b58Bmw.id, b58Supra.id] },
    { sku: 'SM-B58-IC-001', slug: 'b58-upgraded-intercooler', name: 'B58 Upgraded Intercooler', brand: 'SANDMAN Performance', category: 'cooling', price: 44999, cost: 22500, ship: 3500, supplierId: 'MOCK-B58-INTERCOOLER', desc: 'High-capacity intercooler core for B58 performance builds, fulfilled directly by a connected supplier.', fitments: [b58Bmw.id, b58Supra.id] },
    { sku: 'SM-EA888-PLUG-001', slug: 'ea888-performance-spark-plug-set', name: 'EA888 Performance Spark Plug Set', brand: 'SANDMAN', category: 'ignition', price: 8999, cost: 3600, ship: 900, supplierId: 'MOCK-EA888-PLUGS', desc: 'Performance spark plug set for selected EA888 Gen 3 applications.', fitments: [ea888.id] },
    { sku: 'SM-B58-INLET-001', slug: 'b58-high-flow-turbo-inlet', name: 'B58 High-Flow Turbo Inlet', brand: 'Vanta Dynamics', category: 'turbo-boost', price: 13999, compare: 16999, cost: 6800, ship: 1800, supplierId: 'MOCK-B58-INLET', desc: 'High-flow turbo inlet designed to reduce restriction ahead of the compressor.', fitments: [b58Bmw.id, b58Supra.id] },
    { sku: 'SM-N54-CP-001', slug: 'n54-aluminum-charge-pipe', name: 'N54 Aluminum Charge Pipe', brand: 'Forge Line', category: 'turbo-boost', price: 15999, cost: 7900, ship: 2200, supplierId: 'MOCK-N54-CHARGEPIPE', desc: 'Powder-coated aluminum charge pipe with reinforced couplers for N54 performance applications.', fitments: [] },
    { sku: 'SM-K20-GSK-001', slug: 'k20-valve-cover-gasket-kit', name: 'K20 Valve Cover Gasket Kit', brand: 'Kinetic OE', category: 'gaskets-seals', price: 4999, cost: 1900, ship: 700, supplierId: 'MOCK-K20-GASKET', desc: 'Replacement valve cover gasket and seal set for popular K-series applications.', fitments: [] },
    { sku: 'SM-LS-MNT-001', slug: 'ls-swap-engine-mount-kit', name: 'LS Swap Engine Mount Kit', brand: 'Blackline Fabrication', category: 'engine-mounts', price: 24999, cost: 12400, ship: 3200, supplierId: 'MOCK-LS-MOUNTS', desc: 'Heavy-duty engine mount kit for custom LS swap projects. Verify chassis fitment before purchase.', fitments: [] },
    { sku: 'SM-2JZ-FR-001', slug: '2jz-high-flow-fuel-rail', name: '2JZ High-Flow Fuel Rail', brand: 'Nightshift Fuel', category: 'fuel-system', price: 18999, cost: 9200, ship: 1800, supplierId: 'MOCK-2JZ-RAIL', desc: 'CNC-machined high-flow fuel rail for 2JZ performance fuel systems.', fitments: [] },
    { sku: 'SM-OCC-UNI-001', slug: 'universal-baffled-oil-catch-can', name: 'Universal Baffled Oil Catch Can', brand: 'SANDMAN', category: 'engine-components', price: 7999, cost: 3100, ship: 1000, supplierId: 'MOCK-OIL-CATCH', desc: 'Compact baffled oil catch can kit for custom crankcase ventilation setups.', universal: true, fitments: [] },
    { sku: 'SM-EA888-COIL-001', slug: 'ea888-performance-ignition-coil-set', name: 'EA888 Performance Ignition Coil Set', brand: 'Voltwerk', category: 'ignition', price: 17999, cost: 8900, ship: 1400, supplierId: 'MOCK-EA888-COILS', desc: 'Set of four upgraded ignition coils for selected EA888 applications.', fitments: [ea888.id] },
  ] as const;

  for (const def of dropshipDefs) {
    const product = await prisma.product.upsert({
      where: { sku: def.sku },
      update: { sourceType: 'DROPSHIP', condition: 'NEW', requiresFitment: false, warrantyText: '12-month limited supplier warranty where applicable.', returnDays: 30, installDifficulty: 'INTERMEDIATE', shippingMinDays: 4, shippingMaxDays: 10, specs: { source: 'demo', category: def.category } },
      create: {
        sku: def.sku,
        slug: def.slug,
        name: def.name,
        brand: def.brand,
        description: def.desc,
        shortDesc: def.desc,
        categoryId: category(def.category).id,
        priceCents: def.price,
        compareAtCents: 'compare' in def ? def.compare : undefined,
        status: 'ACTIVE',
        sourceType: 'DROPSHIP',
        condition: 'NEW',
        requiresFitment: false,
        isUniversal: ('universal' in def && def.universal) || def.fitments.length === 0,
        warrantyText: '12-month limited supplier warranty where applicable.',
        returnDays: 30,
        installDifficulty: 'INTERMEDIATE',
        shippingMinDays: 4,
        shippingMaxDays: 10,
        specs: { source: 'demo', category: def.category },
        seoTitle: `${def.name} | SANDMAN`,
        seoDescription: def.desc,
        images: { create: [{ url: demoImage(def.name), alt: def.name, position: 0 }] },
        ...(def.fitments.length ? { fitments: { create: def.fitments.map(vehicleVariantId => ({ vehicleVariantId })) } } : {}),
      },
    });

    await prisma.supplierProduct.upsert({
      where: { supplierId_supplierProductId: { supplierId: mockSupplier.id, supplierProductId: def.supplierId } },
      update: { productId: product.id, costCents: def.cost, shippingCents: def.ship, stock: 100, reservedStock: 0, availableStock: 100, active: true },
      create: { supplierId: mockSupplier.id, productId: product.id, supplierProductId: def.supplierId, costCents: def.cost, shippingCents: def.ship, stock: 100, availableStock: 100 },
    });
  }

  const marketplaceDefs = [
    { sku: 'SM-MKT-DEMO-GTX3582', slug: 'used-garrett-gtx3582r-demo', name: 'Garrett GTX3582R Turbo — Used', brand: 'Garrett', category: 'turbo-boost', price: 62000, condition: 'USED' as const, stock: 1, shipping: 4500, location: 'Johannesburg, ZA', desc: 'Demo marketplace listing. Used GTX3582R-style turbo listing with normal cosmetic wear. Buyer should verify measurements, shaft play and application before purchase.' },
    { sku: 'SM-MKT-DEMO-2JZHEAD', slug: 'rebuilt-2jz-gte-cylinder-head-demo', name: 'Rebuilt 2JZ-GTE Cylinder Head', brand: 'Toyota', category: 'engine-components', price: 145000, condition: 'REMANUFACTURED' as const, stock: 1, shipping: 9500, location: 'Cape Town, ZA', desc: 'Demo seller listing for a rebuilt 2JZ-GTE cylinder head. Marketplace seller is responsible for listing accuracy and shipment.' },
  ];

  for (const def of marketplaceDefs) {
    await prisma.product.upsert({
      where: { sku: def.sku },
      update: { sourceType: 'MARKETPLACE', sellerId: demoSeller.id, stockQuantity: def.stock, returnDays: 7, installDifficulty: 'VERIFY_APPLICATION', shippingMinDays: 2, shippingMaxDays: 7 },
      create: {
        sku: def.sku,
        slug: def.slug,
        name: def.name,
        brand: def.brand,
        description: def.desc,
        shortDesc: def.desc,
        categoryId: category(def.category).id,
        priceCents: def.price,
        status: 'ACTIVE',
        sourceType: 'MARKETPLACE',
        condition: def.condition,
        sellerId: demoSeller.id,
        stockQuantity: def.stock,
        sellerShippingCents: def.shipping,
        sellerLocation: def.location,
        requiresFitment: false,
        isUniversal: true,
        returnDays: 7,
        installDifficulty: 'VERIFY_APPLICATION',
        shippingMinDays: 2,
        shippingMaxDays: 7,
        seoTitle: `${def.name} | SANDMAN Marketplace`,
        seoDescription: def.desc,
        images: { create: [{ url: demoImage(def.name), alt: def.name, position: 0 }] },
      },
    });
  }

  await prisma.promoCode.upsert({
    where: { code: 'DREAM10' },
    update: {},
    create: { code: 'DREAM10', percentOff: 10, minimumCents: 5000, maxUses: 100, active: true },
  });

  const defaultPricing = await prisma.pricingRule.findFirst({ where: { name: 'SANDMAN default dropship margin' } });
  if (!defaultPricing) {
    await prisma.pricingRule.create({ data: { name: 'SANDMAN default dropship margin', markupPercent: 35, minimumProfitCents: 2500, priority: 500, active: true } });
  }

  console.log('SANDMAN marketplace seed complete');
  console.log('Demo accounts created/verified for local or staging use. Change/remove demo credentials before any real launch.');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
}).finally(async () => prisma.$disconnect());
