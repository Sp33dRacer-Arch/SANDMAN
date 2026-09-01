import { prisma } from '../lib/prisma';

export type VinDecode = {
  vin: string;
  make: string | null;
  model: string | null;
  modelYear: number | null;
  trim: string | null;
  series: string | null;
  engineModel: string | null;
  displacementL: number | null;
  cylinders: number | null;
  fuelType: string | null;
  driveType: string | null;
  bodyClass: string | null;
  vehicleType: string | null;
  errorCode: string | null;
  errorText: string | null;
};

const VIN_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const vinDecodeCache = new Map<string, { expiresAt: number; value: VinDecode }>();

export type VinVariantCandidate = {
  id: string;
  score: number;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  reasons: string[];
  yearStart: number;
  yearEnd: number;
  trim: string | null;
  chassisCode: string | null;
  engineCode: string;
  engineName: string;
  model: { name: string; make: { name: string } };
};

export function normalizeVin(input: string) {
  return input.trim().toUpperCase().replace(/\s+/g, '');
}

export function isValidFullVin(vin: string) {
  return /^[A-HJ-NPR-Z0-9]{17}$/.test(normalizeVin(vin));
}

function clean(value: unknown) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed && trimmed !== '0' && trimmed.toLowerCase() !== 'not applicable' ? trimmed : null;
}

function numberValue(value: unknown) {
  const raw = clean(value);
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function compact(value: string | null) {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function containsEither(a: string | null, b: string | null) {
  const left = compact(a);
  const right = compact(b);
  return Boolean(left && right && (left.includes(right) || right.includes(left)));
}

export async function decodeVinWithNhtsa(input: string): Promise<VinDecode> {
  const vin = normalizeVin(input);
  if (!isValidFullVin(vin)) throw new Error('VIN must be 17 characters and cannot contain I, O or Q');

  const cached = vinDecodeCache.get(vin);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  if (cached) vinDecodeCache.delete(vin);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const url = `https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValuesExtended/${encodeURIComponent(vin)}?format=json`;
    const response = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json', 'user-agent': 'SANDMAN/2.3 VIN lookup' } });
    if (!response.ok) throw new Error(`NHTSA VIN service returned ${response.status}`);
    const payload = await response.json() as { Results?: Array<Record<string, unknown>> };
    const row = payload.Results?.[0];
    if (!row) throw new Error('VIN could not be decoded');
    const decoded: VinDecode = {
      vin,
      make: clean(row.Make),
      model: clean(row.Model),
      modelYear: numberValue(row.ModelYear),
      trim: clean(row.Trim),
      series: clean(row.Series),
      engineModel: clean(row.EngineModel),
      displacementL: numberValue(row.DisplacementL),
      cylinders: numberValue(row.EngineCylinders),
      fuelType: clean(row.FuelTypePrimary),
      driveType: clean(row.DriveType),
      bodyClass: clean(row.BodyClass),
      vehicleType: clean(row.VehicleType),
      errorCode: clean(row.ErrorCode),
      errorText: clean(row.ErrorText),
    };
    vinDecodeCache.set(vin, { expiresAt: Date.now() + VIN_CACHE_TTL_MS, value: decoded });
    if (vinDecodeCache.size > 1000) {
      const oldest = vinDecodeCache.keys().next().value as string | undefined;
      if (oldest) vinDecodeCache.delete(oldest);
    }
    return decoded;
  } finally {
    clearTimeout(timeout);
  }
}

export function scoreVinCandidate(decoded: VinDecode, candidate: {
  yearStart: number;
  yearEnd: number;
  trim: string | null;
  engineCode: string;
  engineName: string;
  displacementCc: number | null;
  model: { name: string; make: { name: string } };
}) {
  let score = 0;
  const reasons: string[] = [];

  if (decoded.make && compact(decoded.make) === compact(candidate.model.make.name)) { score += 30; reasons.push('make'); }
  if (decoded.model && compact(decoded.model) === compact(candidate.model.name)) { score += 30; reasons.push('model'); }
  else if (decoded.model && containsEither(decoded.model, candidate.model.name)) { score += 18; reasons.push('model-family'); }
  if (decoded.modelYear && decoded.modelYear >= candidate.yearStart && decoded.modelYear <= candidate.yearEnd) { score += 18; reasons.push('year'); }
  if (decoded.engineModel && (containsEither(decoded.engineModel, candidate.engineCode) || containsEither(decoded.engineModel, candidate.engineName))) { score += 18; reasons.push('engine'); }
  if (decoded.trim && candidate.trim && containsEither(decoded.trim, candidate.trim)) { score += 8; reasons.push('trim'); }
  if (decoded.displacementL && candidate.displacementCc) {
    const litres = candidate.displacementCc / 1000;
    if (Math.abs(litres - decoded.displacementL) <= 0.15) { score += 6; reasons.push('displacement'); }
  }
  return { score: Math.min(100, score), reasons };
}

export async function resolveVinCandidates(decoded: VinDecode) {
  if (!decoded.make || !decoded.modelYear) return { matchedVariant: null, candidates: [] as VinVariantCandidate[] };

  const candidates = await prisma.vehicleVariant.findMany({
    where: {
      yearStart: { lte: decoded.modelYear },
      yearEnd: { gte: decoded.modelYear },
      model: {
        make: { name: { equals: decoded.make, mode: 'insensitive' } },
        ...(decoded.model ? { name: { contains: decoded.model, mode: 'insensitive' } } : {}),
      },
    },
    include: { model: { include: { make: true } } },
    take: 40,
  });

  // If NHTSA's model wording is more verbose than the catalogue (for example "3 Series" vs "340i"),
  // retry at make/year level and let the scorer surface likely variants rather than claiming a match.
  const pool = candidates.length ? candidates : await prisma.vehicleVariant.findMany({
    where: {
      yearStart: { lte: decoded.modelYear },
      yearEnd: { gte: decoded.modelYear },
      model: { make: { name: { equals: decoded.make, mode: 'insensitive' } } },
    },
    include: { model: { include: { make: true } } },
    take: 80,
  });

  const ranked: VinVariantCandidate[] = pool
    .map(candidate => {
      const scored = scoreVinCandidate(decoded, candidate);
      const confidence: VinVariantCandidate['confidence'] = scored.score >= 82 ? 'HIGH' : scored.score >= 60 ? 'MEDIUM' : 'LOW';
      return {
        id: candidate.id,
        score: scored.score,
        confidence,
        reasons: scored.reasons,
        yearStart: candidate.yearStart,
        yearEnd: candidate.yearEnd,
        trim: candidate.trim,
        chassisCode: candidate.chassisCode,
        engineCode: candidate.engineCode,
        engineName: candidate.engineName,
        model: { name: candidate.model.name, make: { name: candidate.model.make.name } },
      };
    })
    .filter(candidate => candidate.score >= 45)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);

  const top = ranked[0];
  const second = ranked[1];
  const matchedVariant = top && top.score >= 82 && (!second || top.score - second.score >= 8) ? top : null;
  return { matchedVariant, candidates: ranked };
}
