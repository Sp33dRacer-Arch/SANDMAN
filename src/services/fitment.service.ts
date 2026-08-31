export type FitmentStatus = 'UNIVERSAL' | 'VERIFIED_FIT' | 'CATALOG_FIT' | 'DOES_NOT_FIT' | 'UNKNOWN';

type FitmentRow = {
  vehicleVariantId: string;
  verified?: boolean;
  source?: string;
  notes?: string | null;
  verifiedAt?: Date | null;
};

type FitmentProduct = {
  requiresFitment: boolean;
  isUniversal: boolean;
  fitments: FitmentRow[];
};

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

  const verified = Boolean(match.verified);
  return {
    status: (verified ? 'VERIFIED_FIT' : 'CATALOG_FIT') as FitmentStatus,
    fits: true,
    verified,
    reason: verified ? 'Compatibility has been verified' : 'Compatibility exists in the catalogue but has not been manually verified',
    evidence: {
      source: match.source ?? 'MANUAL',
      notes: match.notes ?? null,
      verifiedAt: match.verifiedAt ?? null,
    },
  };
}
