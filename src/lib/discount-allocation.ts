/**
 * Allocate an order-level discount across line items without ever assigning
 * more discount to a line than that line's gross value. The largest-remainder
 * step keeps the allocated cents equal to the exact order discount.
 */
export function allocateDiscountCents(
  lines: Array<{ id: string; totalCents: number }>,
  discountCents: number,
) {
  const normalized = lines.map(line => ({ ...line, totalCents: Math.max(0, Math.trunc(line.totalCents)) }));
  const total = normalized.reduce((sum, line) => sum + line.totalCents, 0);
  const capped = Math.max(0, Math.min(Math.trunc(discountCents), total));
  const allocations = new Map<string, number>();

  if (!normalized.length || total <= 0 || capped <= 0) {
    for (const line of normalized) allocations.set(line.id, 0);
    return allocations;
  }

  const shares = normalized.map((line, index) => {
    const numerator = capped * line.totalCents;
    const floor = Math.min(line.totalCents, Math.floor(numerator / total));
    allocations.set(line.id, floor);
    return { index, id: line.id, totalCents: line.totalCents, remainder: numerator % total };
  });

  let remaining = capped - [...allocations.values()].reduce((sum, amount) => sum + amount, 0);
  shares.sort((a, b) => b.remainder - a.remainder || a.index - b.index);

  for (const share of shares) {
    if (remaining <= 0) break;
    const current = allocations.get(share.id) ?? 0;
    if (current >= share.totalCents) continue;
    allocations.set(share.id, current + 1);
    remaining -= 1;
  }

  // This should be unreachable with proportional floors, but keep a bounded
  // capacity-based fallback so the function stays correct if its math changes.
  if (remaining > 0) {
    for (const line of normalized) {
      if (remaining <= 0) break;
      const current = allocations.get(line.id) ?? 0;
      const extra = Math.min(line.totalCents - current, remaining);
      if (extra > 0) {
        allocations.set(line.id, current + extra);
        remaining -= extra;
      }
    }
  }

  return allocations;
}
