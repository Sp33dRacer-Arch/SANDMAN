import { env } from '../config/env';
import { HttpError } from '../lib/http-error';
import type { SupplierAdapter, SubmitSupplierOrderInput } from './supplier-adapter';

/**
 * CJ integration boundary.
 * CJ's live API payloads can vary by account/API version, so all CJ-specific
 * mapping is isolated here. Verify request fields against your CJ developer
 * account before production use.
 */
export class CjSupplierAdapter implements SupplierAdapter {
  private async request(path: string, init: RequestInit = {}) {
    if (!env.CJ_API_KEY) throw new HttpError(503, 'CJ supplier API is not configured');
    const response = await fetch(`${env.CJ_BASE_URL}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        'CJ-Access-Token': env.CJ_API_KEY,
        ...(init.headers ?? {}),
      },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new HttpError(502, `CJ API error (${response.status})`, body);
    return body as any;
  }

  async submitOrder(input: SubmitSupplierOrderInput) {
    const body = await this.request('/shopping/order/createOrderV2', {
      method: 'POST',
      body: JSON.stringify({
        orderNumber: input.reference,
        shippingZip: input.shippingAddress.postalCode,
        shippingCountryCode: input.shippingAddress.country,
        shippingCountry: input.shippingAddress.country,
        shippingProvince: input.shippingAddress.state ?? '',
        shippingCity: input.shippingAddress.city,
        shippingAddress: input.shippingAddress.line1,
        shippingAddress2: input.shippingAddress.line2 ?? '',
        shippingCustomerName: `${input.shippingAddress.firstName} ${input.shippingAddress.lastName}`,
        shippingPhone: input.shippingAddress.phone ?? '',
        products: input.items.map(item => ({
          vid: item.supplierProductId,
          quantity: item.quantity,
        })),
      }),
    });

    const id = body?.data?.orderId ?? body?.data?.orderNum ?? body?.result?.orderId;
    if (!id) throw new HttpError(502, 'CJ did not return a supplier order ID', body);
    return { supplierOrderId: String(id), status: 'accepted' as const, raw: body };
  }

  async getTracking(supplierOrderId: string) {
    const body = await this.request(`/logistic/trackInfo?orderId=${encodeURIComponent(supplierOrderId)}`);
    const trackingNumber = body?.data?.trackingNumber ?? body?.data?.trackNumber;
    return {
      status: trackingNumber ? 'shipped' as const : 'processing' as const,
      trackingNumber: trackingNumber ? String(trackingNumber) : undefined,
      carrier: body?.data?.logisticName,
      raw: body,
    };
  }
}
