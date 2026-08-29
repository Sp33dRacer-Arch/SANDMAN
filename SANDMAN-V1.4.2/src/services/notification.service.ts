import { prisma } from '../lib/prisma';

export async function createNotification(input: { userId: string; type: string; title: string; body: string; link?: string }) {
  return prisma.notification.create({ data: input });
}
