import { prisma } from '../lib/prisma';
import { env } from '../config/env';
import { HttpError } from '../lib/http-error';

const upper = (value?: string | null) => String(value || '').trim().toUpperCase();

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').map(item => upper(item))
    : [];
}

export type CommerceAddress = {
  country: string;
  state?: string | null;
  postalCode?: string | null;
  city?: string | null;
};

export type CommerceLine = {
  id: string;
  productId: string;
  name: string;
  quantity: number;
  baseUnitPriceCents: number;
  acceptedOffer: boolean;
  taxable: boolean;
  sourceType: 'DROPSHIP' | 'MARKETPLACE';
  sellerShippingCents: number;
  weightGrams?: number | null;
  lengthMm?: number | null;
  widthMm?: number | null;
  heightMm?: number | null;
  hsCode?: string | null;
  countryOfOrigin?: string | null;
  customsDescription?: string | null;
  restrictedCountries?: unknown;
  warehouseCountry?: string | null;
  regionalPrices?: Array<{ regionKey: string; currency: string; priceCents: number }>;
};

export type PricedCommerceLine = CommerceLine & {
  unitPriceCents: number;
  lineGrossCents: number;
  lineDiscountCents: number;
  lineNetCents: number;
};

export type CommerceQuote = {
  subtotalCents: number;
  shippingCents: number;
  taxCents: number;
  discountCents: number;
  dutyCents: number;
  totalCents: number;
  taxJurisdiction: string | null;
  taxRateBps: number | null;
  taxInclusive: boolean | null;
  importScheme: string | null;
  shippingQuoteMeta: Record<string, unknown>;
  settlementCurrency: string;
  allowedPaymentProviders: Array<'stripe' | 'paypal' | 'bank_transfer'>;
  lines: PricedCommerceLine[];
};

function normalizedPaymentMethods(value: unknown): Array<'stripe' | 'paypal' | 'bank_transfer'> {
  const methods = stringArray(value);
  const result: Array<'stripe' | 'paypal' | 'bank_transfer'> = [];
  if (methods.includes('STRIPE')) result.push('stripe');
  if (methods.includes('PAYPAL')) result.push('paypal');
  if (methods.includes('BANK_TRANSFER') || methods.includes('BANK') || methods.includes('EFT')) result.push('bank_transfer');
  return result;
}

export async function commerceContext(countryInput?: string | null, currencyInput?: string | null) {
  const baseCurrency = upper(env.CURRENCY) || 'USD';
  const country = upper(countryInput).slice(0, 2);
  const region = country ? await prisma.commerceRegion.findUnique({ where: { country } }) : null;
  const rates = await prisma.fxRate.findMany({ where: { baseCurrency }, orderBy: { quoteCurrency: 'asc' } });
  const supportedCurrencies = [...new Set([baseCurrency, ...rates.map(rate => rate.quoteCurrency)])];
  const preferred = upper(currencyInput || region?.currency || baseCurrency);
  const displayCurrency = supportedCurrencies.includes(preferred) ? preferred : baseCurrency;
  const selectedRate = rates.find(rate => rate.quoteCurrency === displayCurrency);

  return {
    baseCurrency,
    settlementCurrency: baseCurrency,
    displayCurrency,
    displayOnly: true,
    fxRate: displayCurrency === baseCurrency ? 1 : selectedRate?.rate ?? null,
    supportedCurrencies,
    country: country || null,
    locale: region?.locale || env.DEFAULT_LOCALE,
    shippingAllowed: region?.shippingAllowed ?? false,
    taxRequired: region?.taxRequired ?? true,
    dutiesRequired: region?.dutiesRequired ?? false,
    paymentMethods: normalizedPaymentMethods(region?.paymentMethods),
    importScheme: region?.importScheme || null,
    regionConfigured: Boolean(region),
    rateUpdatedAt: selectedRate?.fetchedAt ?? null,
  };
}

async function postSignedJson(url: string | undefined, secret: string | undefined, payload: Record<string, unknown>) {
  if (!url) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(secret ? { authorization: `Bearer ${secret}` } : {}),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return await response.json() as Record<string, unknown>;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function regionPriceFor(line: CommerceLine, address: CommerceAddress) {
  if (line.acceptedOffer) return line.baseUnitPriceCents;
  const settlementCurrency = upper(env.CURRENCY);
  const country = upper(address.country);
  const state = upper(address.state);
  const keys = state ? [`${country}-${state}`, country, 'GLOBAL'] : [country, 'GLOBAL'];
  for (const key of keys) {
    const match = line.regionalPrices?.find(price => upper(price.regionKey) === key && upper(price.currency) === settlementCurrency);
    if (match) return match.priceCents;
  }
  return line.baseUnitPriceCents;
}

function shippingItems(lines: PricedCommerceLine[]) {
  return lines
    .filter(line => line.sourceType === 'DROPSHIP')
    .map(line => ({
      productId: line.productId,
      name: line.name,
      quantity: line.quantity,
      unitValueCents: line.unitPriceCents,
      lineValueCents: line.lineNetCents,
      weightGrams: line.weightGrams ?? null,
      dimensionsMm: {
        length: line.lengthMm ?? null,
        width: line.widthMm ?? null,
        height: line.heightMm ?? null,
      },
      warehouseCountry: line.warehouseCountry ?? null,
      hsCode: line.hsCode ?? null,
      countryOfOrigin: line.countryOfOrigin ?? null,
      customsDescription: line.customsDescription ?? line.name,
    }));
}

function restrictedInCountry(line: CommerceLine, country: string) {
  const values = stringArray(line.restrictedCountries);
  return values.includes(country) || values.includes('*');
}

export async function resolveCommerceLines(lines: CommerceLine[], address: CommerceAddress) {
  const country = upper(address.country).slice(0, 2);
  return lines.map(line => {
    if (restrictedInCountry(line, country)) {
      throw new HttpError(409, `${line.name} cannot be shipped to ${country}`);
    }
    const unitPriceCents = regionPriceFor(line, address);
    return { ...line, unitPriceCents };
  });
}

export async function quoteGlobalCommerce(input: {
  address: CommerceAddress;
  lines: Array<CommerceLine & { unitPriceCents: number }>;
  discountByLineId: Map<string, number>;
}) : Promise<CommerceQuote> {
  const country = upper(input.address.country).slice(0, 2);
  const state = upper(input.address.state).slice(0, 40) || null;
  const commerceRegion = await prisma.commerceRegion.findUnique({ where: { country } });

  if (!commerceRegion) {
    throw new HttpError(409, `Shipping to ${country} is not configured yet. Please request a shipping quote or choose a supported destination.`);
  }
  if (!commerceRegion.shippingAllowed) {
    throw new HttpError(409, `SANDMAN is not currently configured to ship to ${country}`);
  }

  const allowedPaymentProviders = normalizedPaymentMethods(commerceRegion.paymentMethods);
  if (!allowedPaymentProviders.length) {
    throw new HttpError(409, `No checkout payment method is configured for ${country}`);
  }

  const priced: PricedCommerceLine[] = input.lines.map(line => {
    const lineGrossCents = line.unitPriceCents * line.quantity;
    const lineDiscountCents = Math.max(0, Math.min(input.discountByLineId.get(line.id) ?? 0, lineGrossCents));
    return {
      ...line,
      lineGrossCents,
      lineDiscountCents,
      lineNetCents: Math.max(0, lineGrossCents - lineDiscountCents),
    };
  });

  const subtotalCents = priced.reduce((sum, line) => sum + line.lineGrossCents, 0);
  const discountCents = priced.reduce((sum, line) => sum + line.lineDiscountCents, 0);
  const discountedSubtotalCents = Math.max(0, subtotalCents - discountCents);
  const sellerShippingCents = priced
    .filter(line => line.sourceType === 'MARKETPLACE')
    .reduce((sum, line) => sum + line.sellerShippingCents * line.quantity, 0);

  const dropshipLines = priced.filter(line => line.sourceType === 'DROPSHIP');
  let dropshipShippingCents = 0;
  let shippingQuoteMeta: Record<string, unknown> = { source: 'NONE' };

  if (dropshipLines.length) {
    const items = shippingItems(priced);
    const carrierResponse = await postSignedJson(env.CARRIER_RATE_WEBHOOK_URL, env.CARRIER_RATE_WEBHOOK_SECRET, {
      type: 'SANDMAN_SHIPPING_QUOTE',
      currency: upper(env.CURRENCY),
      destination: {
        country,
        region: state,
        postalCode: input.address.postalCode || null,
        city: input.address.city || null,
      },
      items,
      cartSubtotalCents: discountedSubtotalCents,
    });

    if (carrierResponse && Number.isInteger(carrierResponse.shippingCents) && Number(carrierResponse.shippingCents) >= 0) {
      dropshipShippingCents = Number(carrierResponse.shippingCents);
      shippingQuoteMeta = {
        source: 'CARRIER_WEBHOOK',
        carrier: typeof carrierResponse.carrier === 'string' ? carrierResponse.carrier : null,
        service: typeof carrierResponse.service === 'string' ? carrierResponse.service : null,
        minDays: Number.isInteger(carrierResponse.minDays) ? carrierResponse.minDays : null,
        maxDays: Number.isInteger(carrierResponse.maxDays) ? carrierResponse.maxDays : null,
      };
    } else {
      const zones = await prisma.shippingZone.findMany({ where: { active: true }, orderBy: { priority: 'desc' } });
      const zone = zones.find(row => {
        const countries = stringArray(row.countries);
        return countries.includes(country) || countries.includes('*');
      });
      if (!zone) {
        throw new HttpError(409, `No shipping rate is configured for ${country}. Please request a shipping quote.`);
      }
      if (upper(zone.currency) !== upper(env.CURRENCY)) {
        throw new HttpError(500, `Shipping zone ${zone.name} does not use the checkout settlement currency`);
      }
      dropshipShippingCents = discountedSubtotalCents >= (zone.freeShippingThresholdCents ?? Number.MAX_SAFE_INTEGER)
        ? 0
        : zone.rateCents;
      shippingQuoteMeta = {
        source: 'SHIPPING_ZONE',
        zoneId: zone.id,
        zone: zone.name,
        carrier: zone.carrierCode,
        service: zone.serviceCode,
        minDays: zone.minDays,
        maxDays: zone.maxDays,
      };
    }
  }

  const shippingCents = dropshipShippingCents + sellerShippingCents;

  const taxRules = await prisma.taxRule.findMany({ where: { active: true, country }, orderBy: { priority: 'desc' } });
  const taxRule = taxRules.find(rule => rule.region && upper(rule.region) === state) || taxRules.find(rule => !rule.region) || null;
  if (commerceRegion.taxRequired && !taxRule) {
    throw new HttpError(409, `Tax calculation is not configured for ${country}${state ? `-${state}` : ''}`);
  }

  let taxCents = 0;
  let taxRateBps: number | null = null;
  let taxInclusive: boolean | null = null;
  let taxJurisdiction: string | null = null;

  if (taxRule) {
    taxRateBps = taxRule.rateBps;
    taxInclusive = taxRule.taxInclusive;
    taxJurisdiction = `${taxRule.country}${taxRule.region ? `-${taxRule.region}` : ''}`;
    const taxableProductsCents = priced.filter(line => line.taxable).reduce((sum, line) => sum + line.lineNetCents, 0);
    const taxableBaseCents = taxableProductsCents + (taxRule.appliesToShipping ? shippingCents : 0);
    const rate = taxRule.rateBps / 10_000;
    taxCents = taxRule.taxInclusive
      ? (rate > 0 ? Math.round(taxableBaseCents - (taxableBaseCents / (1 + rate))) : 0)
      : Math.round(taxableBaseCents * rate);
  }

  let dutyCents = 0;
  if (commerceRegion.dutiesRequired) {
    if (!env.DUTY_CALCULATION_WEBHOOK_URL) {
      throw new HttpError(409, `Duty calculation is required for ${country} but no duty provider is configured`);
    }
    for (const line of priced) {
      if (!line.hsCode || !line.countryOfOrigin) {
        throw new HttpError(409, `${line.name} is missing HS code or country-of-origin data required for international duty calculation`);
      }
    }
    const dutyResponse = await postSignedJson(env.DUTY_CALCULATION_WEBHOOK_URL, env.DUTY_CALCULATION_WEBHOOK_SECRET, {
      type: 'SANDMAN_DUTY_QUOTE',
      currency: upper(env.CURRENCY),
      destination: {
        country,
        region: state,
        postalCode: input.address.postalCode || null,
        city: input.address.city || null,
      },
      shippingCents,
      items: shippingItems(priced),
    });
    if (!dutyResponse || !Number.isInteger(dutyResponse.dutyCents) || Number(dutyResponse.dutyCents) < 0) {
      throw new HttpError(502, 'The duty provider did not return a valid landed-cost quote');
    }
    dutyCents = Number(dutyResponse.dutyCents);
  }

  const exclusiveTaxCents = taxInclusive ? 0 : taxCents;
  const totalCents = discountedSubtotalCents + shippingCents + exclusiveTaxCents + dutyCents;

  return {
    subtotalCents,
    shippingCents,
    taxCents,
    discountCents,
    dutyCents,
    totalCents,
    taxJurisdiction,
    taxRateBps,
    taxInclusive,
    importScheme: commerceRegion.importScheme,
    shippingQuoteMeta,
    settlementCurrency: upper(env.CURRENCY),
    allowedPaymentProviders,
    lines: priced,
  };
}

export function assertPaymentProviderAllowed(
  provider: 'stripe' | 'paypal' | 'bank_transfer',
  allowed: Array<'stripe' | 'paypal' | 'bank_transfer'>,
  country: string,
) {
  if (!allowed.includes(provider)) {
    throw new HttpError(409, `${provider.replace('_', ' ')} is not enabled for checkout in ${upper(country)}`);
  }
}
