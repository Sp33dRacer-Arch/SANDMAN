export type SupplierOrderItem = {
  supplierProductId: string;
  sku?: string | null;
  quantity: number;
};

export type SupplierShippingAddress = {
  firstName: string;
  lastName: string;
  line1: string;
  line2?: string;
  city: string;
  state?: string;
  postalCode: string;
  country: string;
  phone?: string;
};

export type SubmitSupplierOrderInput = {
  reference: string;
  items: SupplierOrderItem[];
  shippingAddress: SupplierShippingAddress;
};

export type SubmitSupplierOrderResult = {
  supplierOrderId: string;
  status: 'accepted' | 'processing';
  raw?: unknown;
};

export type SupplierTrackingResult = {
  status: 'processing' | 'shipped' | 'delivered' | 'cancelled';
  trackingNumber?: string;
  trackingUrl?: string;
  carrier?: string;
  raw?: unknown;
};

export interface SupplierAdapter {
  submitOrder(input: SubmitSupplierOrderInput): Promise<SubmitSupplierOrderResult>;
  getTracking(supplierOrderId: string): Promise<SupplierTrackingResult>;
}
