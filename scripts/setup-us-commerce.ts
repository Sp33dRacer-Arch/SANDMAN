import { prisma } from '../src/lib/prisma';

async function main() {
  const region = await prisma.commerceRegion.upsert({
    where: { country: 'US' },
    update: {
      locale: 'en-US',
      currency: 'USD',
      shippingAllowed: true,
      taxRequired: false,
      dutiesRequired: false,
      paymentMethods: ['PAYPAL'],
    },
    create: {
      country: 'US',
      locale: 'en-US',
      currency: 'USD',
      shippingAllowed: true,
      taxRequired: false,
      dutiesRequired: false,
      paymentMethods: ['PAYPAL'],
    },
  });

  const zones = await prisma.shippingZone.findMany({
    where: { active: true },
  });

  const usZone = zones.find((zone) => {
    return Array.isArray(zone.countries) &&
      zone.countries.some((country) => country === 'US');
  });

  const zone = usZone ?? await prisma.shippingZone.create({
    data: {
      name: 'United States',
      countries: ['US'],
      currency: 'USD',
      rateCents: 1800,
      freeShippingThresholdCents: 25000,
      minDays: 5,
      maxDays: 14,
      priority: 200,
      active: true,
    },
  });

  console.log('USA commerce region configured:', region);
  console.log('USA shipping zone configured:', zone);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });


