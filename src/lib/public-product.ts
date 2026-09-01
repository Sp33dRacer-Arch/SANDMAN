/**
 * Strip seller-only listing notes before a Product object leaves a buyer/public
 * API. Keep this helper tiny so it can be reused on differently-shaped Prisma
 * Product payloads without duplicating response-leak logic.
 */
export function publicProduct<T extends { sellerNotes?: unknown }>(product: T): Omit<T, 'sellerNotes'> {
  const { sellerNotes: _sellerNotes, ...safe } = product;
  return safe;
}
