import { prisma } from '../lib/prisma';

export async function audit(input: { actorUserId?: string; action: string; targetType: string; targetId?: string; metadata?: Record<string, unknown> }) {
  return prisma.auditLog.create({
    data: {
      actorUserId: input.actorUserId,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      metadata: input.metadata as any,
    },
  });
}
