export type ActiveOrderFulfillmentStatus = 'PROCESSING' | 'SUBMITTED_TO_SUPPLIER' | 'PARTIALLY_FULFILLED' | 'FULFILLED';

export function computeActiveOrderFulfillmentStatus(input: {
  marketplaceOpenLines: number;
  marketplaceShippedLines: number;
  activeDropshipSupplierIds: Iterable<string>;
  shippedDropshipSupplierIds: Iterable<string>;
}): ActiveOrderFulfillmentStatus {
  const activeSuppliers = new Set(input.activeDropshipSupplierIds);
  const shippedActiveSuppliers = new Set([...input.shippedDropshipSupplierIds].filter(id => activeSuppliers.has(id)));
  const totalUnits = Math.max(0, input.marketplaceOpenLines) + activeSuppliers.size;
  const doneUnits = Math.min(Math.max(0, input.marketplaceShippedLines), Math.max(0, input.marketplaceOpenLines)) + shippedActiveSuppliers.size;

  if (totalUnits > 0 && doneUnits >= totalUnits) return 'FULFILLED';
  if (doneUnits > 0) return 'PARTIALLY_FULFILLED';
  if (activeSuppliers.size > 0 && input.marketplaceOpenLines === 0) return 'SUBMITTED_TO_SUPPLIER';
  return 'PROCESSING';
}
