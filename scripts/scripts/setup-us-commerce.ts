import { prisma } from '../src/lib/prisma';

async function main() {
  const region = await prisma.commerceRegion.upsert({
    where: { country: 'US' },
    update: {
      locale: 'en-US',
      currency: 'USD',
      shippingAllowed: true,
      taxRequired: true,
      dutiesRequired: true,
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

  const existingZone = await prisma.shippingZone.findFirst({
    where: {
      active: true,
      countries: {
        array_contains: 'US',
      },
    },
  });

  const zone =
    existingZone ??
    (await prisma.shippingZone.create({
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
    }));

  console.log('US commerce region:', region);
  console.log('US shipping zone:', zone);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });