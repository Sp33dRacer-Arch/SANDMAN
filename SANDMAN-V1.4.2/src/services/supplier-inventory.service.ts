import type { Prisma } from '@prisma/client';

/**
 * Supplier stock is stored as the latest local snapshot in `stock`.
 * `reservedStock` is held by live checkouts / paid orders that have not yet
 * been accepted by the supplier. `availableStock` is the buyer-facing amount.
 * A null stock/availableStock means the supplier feed does not provide a hard
 * quantity, so SANDMAN treats it as unknown rather than sold out.
 */
export async function reserveSupplierInventory(
  tx: Prisma.TransactionClient,
  supplierLinkId: string,
  quantity: number,
) {
  if (!Number.isInteger(quantity) || quantity < 1) return false;
  const changed = await tx.$executeRaw`
    UPDATE "SupplierProduct"
    SET
      "reservedStock" = "reservedStock" + ${quantity},
      "availableStock" = CASE
        WHEN "availableStock" IS NULL THEN NULL
        ELSE "availableStock" - ${quantity}
      END,
      "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = ${supplierLinkId}
      AND "active" = TRUE
      AND ("availableStock" IS NULL OR "availableStock" >= ${quantity})
      AND EXISTS (
        SELECT 1 FROM "Supplier" s
        WHERE s."id" = "SupplierProduct"."supplierId" AND s."active" = TRUE
      )
  `;
  return changed === 1;
}

export async function releaseSupplierInventory(
  tx: Prisma.TransactionClient,
  supplierLinkId: string,
  quantity: number,
) {
  if (!Number.isInteger(quantity) || quantity < 1) return false;
  const changed = await tx.$executeRaw`
    UPDATE "SupplierProduct"
    SET
      "reservedStock" = "reservedStock" - ${quantity},
      "availableStock" = CASE
        WHEN "stock" IS NULL THEN NULL
        ELSE GREATEST(0, "stock" - ("reservedStock" - ${quantity}))
      END,
      "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = ${supplierLinkId}
      AND "reservedStock" >= ${quantity}
  `;
  return changed === 1;
}

/**
 * Convert a checkout reservation into a supplier-accepted sale. Availability
 * stays reduced; the reservation counter is released and the local stock
 * snapshot is reduced so stock-reserved remains consistent until the next feed.
 */
export async function commitSupplierInventory(
  tx: Prisma.TransactionClient,
  supplierLinkId: string,
  quantity: number,
) {
  if (!Number.isInteger(quantity) || quantity < 1) return false;
  const changed = await tx.$executeRaw`
    UPDATE "SupplierProduct"
    SET
      "reservedStock" = "reservedStock" - ${quantity},
      "stock" = CASE
        WHEN "stock" IS NULL THEN NULL
        ELSE GREATEST(0, "stock" - ${quantity})
      END,
      "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = ${supplierLinkId}
      AND "reservedStock" >= ${quantity}
  `;
  return changed === 1;
}

/** Apply a fresh supplier-reported stock snapshot without erasing live holds. */
export async function setSupplierReportedStock(
  tx: Prisma.TransactionClient,
  supplierLinkId: string,
  stock: number | null,
) {
  if (stock === null) {
    await tx.supplierProduct.update({
      where: { id: supplierLinkId },
      data: { stock: null, availableStock: null, lastSyncedAt: new Date() },
    });
    return null;
  }

  await tx.$executeRaw`
    UPDATE "SupplierProduct"
    SET
      "stock" = ${stock},
      "availableStock" = GREATEST(0, ${stock} - "reservedStock"),
      "lastSyncedAt" = CURRENT_TIMESTAMP,
      "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = ${supplierLinkId}
  `;
  const updated = await tx.supplierProduct.findUnique({
    where: { id: supplierLinkId },
    select: { availableStock: true },
  });
  return updated?.availableStock ?? 0;
}
