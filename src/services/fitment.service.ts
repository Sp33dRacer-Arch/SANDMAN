export type FitmentStatus = 'UNIVERSAL' | 'VERIFIED_FIT' | 'CATALOG_FIT' | 'DOES_NOT_FIT' | 'UNKNOWN';

export type FitmentRow = {
  vehicleVariantId: string;
  verified?: boolean;
  compatibility?: 'FITS' | 'DOES_NOT_FIT';
  source?: string;
  notes?: string | null;
  verifiedAt?: Date | null;
};

export type FitmentProduct = {
  requiresFitment: boolean;
  isUniversal: boolean;
  fitments: FitmentRow[];
};

/**
 * Evidence-first fitment semantics.
 *
 * - Missing evidence is UNKNOWN, never automatically incompatible.
 * - DOES_NOT_FIT is returned only when an explicit negative record exists.
 * - VERIFIED_FIT requires a positive record whose verified flag is true.
 * - CATALOG_FIT is a positive but not manually verified record.
 */
export function evaluateFitment(product: FitmentProduct, vehicleVariantId?: string | null) {
  if (product.isUniversal || !product.requiresFitment) {
    return {
      status: 'UNIVERSAL' as FitmentStatus,
      fits: true,
      verified: true,
      reason: product.isUniversal ? 'Universal-fit product' : 'Vehicle-specific fitment is not required',
      evidence: null,
    };
  }

  if (!vehicleVariantId) {
    return {
      status: 'UNKNOWN' as FitmentStatus,
      fits: null,
      verified: false,
      reason: 'Choose a vehicle to check compatibility',
      evidence: null,
    };
  }

  const match = product.fitments.find(row => row.vehicleVariantId === vehicleVariantId);
  if (!match) {
    return {
      status: 'UNKNOWN' as FitmentStatus,
      fits: null,
      verified: false,
      reason: 'No compatibility record exists for this exact vehicle variant',
      evidence: null,
    };
  }

  const evidence = {
    source: match.source ?? 'MANUAL',
    notes: match.notes ?? null,
    verifiedAt: match.verifiedAt ?? null,
  };

  if (match.compatibility === 'DOES_NOT_FIT') {
    return {
      status: 'DOES_NOT_FIT' as FitmentStatus,
      fits: false,
      verified: Boolean(match.verified),
      reason: match.verified
        ? 'This exact product and vehicle combination has verified incompatibility evidence'
        : 'This product is recorded as incompatible with the selected vehicle',
      evidence,
    };
  }

  const verified = Boolean(match.verified);
  return {
    status: (verified ? 'VERIFIED_FIT' : 'CATALOG_FIT') as FitmentStatus,
    fits: true,
    verified,
    reason: verified
      ? 'Compatibility has been verified'
      : 'Compatibility exists in the catalogue but has not been manually verified',
    evidence,
  };
}
