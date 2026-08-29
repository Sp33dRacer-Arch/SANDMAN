export function effectiveOfferUnitPrice(input: {
  productPriceCents: number;
  quantity: number;
  offer?: { status: string; amountCents: number } | null;
}) {
  return input.offer?.status === 'ACCEPTED' && input.quantity === 1
    ? input.offer.amountCents
    : input.productPriceCents;
}
