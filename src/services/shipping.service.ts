export function trackingUrlFor(carrierInput: string | null | undefined, trackingInput: string | null | undefined) {
  const tracking = (trackingInput ?? '').trim();
  if (!tracking) return null;
  const carrier = (carrierInput ?? '').trim().toLowerCase();
  const encoded = encodeURIComponent(tracking);
  if (carrier.includes('ups')) return `https://www.ups.com/track?tracknum=${encoded}`;
  if (carrier.includes('fedex')) return `https://www.fedex.com/fedextrack/?trknbr=${encoded}`;
  if (carrier.includes('usps')) return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encoded}`;
  if (carrier.includes('dhl')) return `https://www.dhl.com/global-en/home/tracking.html?tracking-id=${encoded}`;
  if (carrier.includes('royal mail')) return `https://www.royalmail.com/track-your-item#/tracking-results/${encoded}`;
  if (carrier.includes('dpd')) return `https://tracking.dpd.de/status/en_US/parcel/${encoded}`;
  if (carrier.includes('aramex')) return `https://www.aramex.com/track/results?ShipmentNumber=${encoded}`;
  return null;
}

export function deliveryWindow(input: {
  productMinDays?: number | null;
  productMaxDays?: number | null;
  supplierLeadTimes?: Array<number | null | undefined>;
}) {
  if (input.productMinDays != null) {
    return { minDays: input.productMinDays, maxDays: input.productMaxDays ?? input.productMinDays, source: 'PRODUCT' as const };
  }
  const leads = (input.supplierLeadTimes ?? []).filter((value): value is number => Number.isInteger(value) && Number(value) >= 0).sort((a, b) => a - b);
  if (leads.length) {
    const lead = leads[0]!;
    return { minDays: lead, maxDays: Math.max(lead + 3, lead), source: 'SUPPLIER' as const };
  }
  return { minDays: null, maxDays: null, source: 'CHECKOUT' as const };
}
