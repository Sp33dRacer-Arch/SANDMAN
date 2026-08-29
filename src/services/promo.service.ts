import type { Prisma } from '@prisma/client';

/**
 * Reserve one use of a promo code atomically. PostgreSQL performs the max-use
 * check and increment in one statement so two simultaneous checkouts cannot
 * both consume the final remaining use.
 */
export async function reservePromoUse(
  tx: Prisma.TransactionClient,
  input: { code: string; subtotalCents: number },
) {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    UPDATE "PromoCode"
    SET "uses" = "uses" + 1,
        "updatedAt" = CURRENT_TIMESTAMP
    WHERE "code" = ${input.code}
      AND "active" = TRUE
      AND "minimumCents" <= ${input.subtotalCents}
      AND ("startsAt" IS NULL OR "startsAt" <= CURRENT_TIMESTAMP)
      AND ("endsAt" IS NULL OR "endsAt" >= CURRENT_TIMESTAMP)
      AND ("maxUses" IS NULL OR "uses" < "maxUses")
    RETURNING "id"
  `;
  return rows.length === 1;
}

/** Release a checkout-time promo reservation exactly once from its caller's transaction. */
export async function releasePromoUse(tx: Prisma.TransactionClient, code: string) {
  await tx.promoCode.updateMany({
    where: { code, uses: { gt: 0 } },
    data: { uses: { decrement: 1 } },
  });
}