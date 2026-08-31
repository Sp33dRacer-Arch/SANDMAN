#!/usr/bin/env node
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
try {
  const [makes, models, variants] = await Promise.all([
    prisma.vehicleMake.count(),
    prisma.vehicleModel.count(),
    prisma.vehicleVariant.count()
  ]);
  console.log({ makes, models, variants });
  const sample = await prisma.vehicleVariant.findMany({
    take: 20,
    include: { model: { include: { make: true } } },
    orderBy: { yearStart: "desc" }
  });
  for (const v of sample) {
    console.log(`${v.model.make.name} | ${v.model.name} | ${v.yearStart}-${v.yearEnd} | ${v.trim ?? "-"} | ${v.chassisCode ?? "-"} | ${v.engineCode} | ${v.engineName}`);
  }
} finally {
  await prisma.$disconnect();
}
