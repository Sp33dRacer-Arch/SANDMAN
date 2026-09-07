import type { Supplier, SupplierType } from '@prisma/client';
import type { SupplierAdapter } from './supplier-adapter';
import { MockSupplierAdapter } from './mock-supplier.adapter';
import { CjSupplierAdapter } from './cj-supplier.adapter';
import { SynceeSupplierAdapter } from './syncee-supplier.adapter';
import { HttpError } from '../lib/http-error';
import { VinyasaSupplierAdapter } from './vinyasa.service';

export function supplierAdapterFor(supplier: Pick<Supplier, 'id' | 'type' | 'code' | 'baseUrl'>): SupplierAdapter {
  const type = supplier.type as SupplierType;
  if (type === 'MOCK') return new MockSupplierAdapter();
  if (type === 'CJ') return new CjSupplierAdapter();
  if (type === 'SYNCEE') return new SynceeSupplierAdapter();
  if (supplier.code.trim().toLowerCase() === 'vinyasa') return new VinyasaSupplierAdapter(supplier);
  throw new HttpError(501, `No adapter implemented for supplier ${supplier.code}`);
}
