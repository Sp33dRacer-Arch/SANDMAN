import { env } from '../config/env';
import type { SupplierAdapter, SubmitSupplierOrderInput, SubmitSupplierOrderResult, SupplierTrackingResult } from './supplier-adapter';

/**
 * Syncee does not currently expose a public retailer-side custom-platform order API.
 * This adapter creates a tracked manual fulfillment handoff instead of pretending
 * an order was submitted. Admin staff complete payment/forwarding inside Syncee.
 */
export class SynceeSupplierAdapter implements SupplierAdapter {
  async submitOrder(input: SubmitSupplierOrderInput): Promise<SubmitSupplierOrderResult> {
    return {
      supplierOrderId: `SYNCEE-${input.reference}`,
      status: 'processing',
      raw: {
        mode: env.SYNCEE_MODE,
        action: 'OPEN_SYNCEE_AND_PAY_SUPPLIER',
        synceeOrdersUrl: env.SYNCEE_ORDERS_URL,
        reference: input.reference,
        shippingAddress: input.shippingAddress,
        items: input.items,
        note: 'Syncee custom retailer API is not publicly documented. Complete the supplier payment/order forwarding in Syncee, then add tracking in SANDMAN.',
      },
    };
  }

  async getTracking(_supplierOrderId: string): Promise<SupplierTrackingResult> {
    return { status: 'processing', raw: { mode: env.SYNCEE_MODE, synceeOrdersUrl: env.SYNCEE_ORDERS_URL } };
  }
}
