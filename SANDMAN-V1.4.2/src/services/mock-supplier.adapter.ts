import type { SupplierAdapter, SubmitSupplierOrderInput } from './supplier-adapter';
import { nanoid } from 'nanoid';

export class MockSupplierAdapter implements SupplierAdapter {
  async submitOrder(_input: SubmitSupplierOrderInput) {
    return {
      supplierOrderId: `MOCK-${nanoid(10).toUpperCase()}`,
      status: 'accepted' as const,
      raw: { sandbox: true },
    };
  }

  async getTracking(supplierOrderId: string) {
    return {
      status: 'processing' as const,
      raw: { sandbox: true, supplierOrderId },
    };
  }
}
