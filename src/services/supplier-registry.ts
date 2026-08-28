import type { Supplier, SupplierType } from '@prisma/client';
import type { SupplierAdapter } from './supplier-adapter';
import { MockSupplierAdapter } from './mock-supplier.adapter';
import { CjSupplierAdapter } from './cj-supplier.adapter';
import { SynceeSupplierAdapter } from './syncee-supplier.adapter';
import { HttpError } from '../lib/http-error';

export function supplierAdapterFor(supplier: Pick<Supplier, 'type' | 'code'>): SupplierAdapter {
  const type = supplier.type as SupplierType;
  if (type === 'MOCK') return new MockSupplierAdapter();
  if (type === 'CJ') return new CjSupplierAdapter();
  if (type === 'SYNCEE') return new SynceeSupplierAdapter();
  throw new HttpError(501, `No adapter implemented for supplier ${supplier.code}`);
}
