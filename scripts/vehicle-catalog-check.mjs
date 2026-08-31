#!/usr/bin/env node
import { PrismaClient, Prisma } from "@prisma/client";
const prisma = new PrismaClient();

try {
  const model = Prisma.dmmf.datamodel.models.find(m => m.name === "VehicleVariant");
  if (!model) throw new Error("VehicleVariant model not found.");
  console.log("VehicleVariant fields:", model.fields.filter(f => f.kind !== "object").map(f => f.name).join(", "));
  const count = await prisma.vehicleVariant.count();
  console.log("VehicleVariant rows:", count);
  const samples = await prisma.vehicleVariant.findMany({ take: 12 });
  console.log("Sample rows:");
  console.dir(samples, { depth: 4 });
} finally {
  await prisma.$disconnect();
}
