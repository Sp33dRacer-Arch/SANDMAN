export function dollarsToCents(value: number): number {
  return Math.round(value * 100);
}

export function centsToDollars(value: number): number {
  return Math.round(value) / 100;
}

export function calculateOrderTotals(input: {
  subtotalCents: number;
  freeShippingThresholdCents: number;
  flatShippingCents: number;
  taxRate: number;
  discountCents?: number;
}) {
  const discountCents = Math.max(0, input.discountCents ?? 0);
  const discountedSubtotal = Math.max(0, input.subtotalCents - discountCents);
  const shippingCents = discountedSubtotal >= input.freeShippingThresholdCents
    ? 0
    : input.flatShippingCents;
  const taxCents = Math.round(discountedSubtotal * input.taxRate);
  return {
    subtotalCents: input.subtotalCents,
    discountCents,
    shippingCents,
    taxCents,
    totalCents: discountedSubtotal + shippingCents + taxCents,
  };
}
