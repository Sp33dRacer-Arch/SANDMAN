import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
  readPrisma?: PrismaClient;
};

export const prisma = globalForPrisma.prisma ?? new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
});

const replicaUrl = process.env.READ_REPLICA_DATABASE_URL?.trim();
export const readPrisma = replicaUrl
  ? (globalForPrisma.readPrisma ?? new PrismaClient({
      // Prisma 6 accepts datasource overrides at construction. The cast keeps
      // this compatible with minor Prisma Client option typing differences.
      datasources: { db: { url: replicaUrl } },
      log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
    } as any))
  : prisma;

export const readReplicaConfigured = Boolean(replicaUrl);

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
  if (replicaUrl) globalForPrisma.readPrisma = readPrisma;
}
