import { createHash, randomBytes } from 'crypto';
import { prisma } from '../lib/prisma';
import { decryptTotpSecret, verifyTotp } from './totp.service';

export function generateRecoveryCodes(count = 10) {
  return Array.from({ length: count }, () => {
    const raw = randomBytes(8).toString('hex').toUpperCase();
    return `${raw.slice(0,4)}-${raw.slice(4,8)}-${raw.slice(8,12)}-${raw.slice(12,16)}`;
  });
}

export function hashRecoveryCode(code: string) {
  return createHash('sha256').update(code.replace(/[^A-Za-z0-9]/g, '').toUpperCase()).digest('hex');
}

export function recoveryHashes(codes: string[]) {
  return codes.map(hashRecoveryCode);
}

export async function verifySecondFactor(input: { userId: string; secretEnc: string; code: string; consumeRecovery?: boolean }) {
  const value = input.code.trim();
  if (/^\d{6}$/.test(value) && verifyTotp(decryptTotpSecret(input.secretEnc), value)) return { ok: true, method: 'totp' as const };

  const hash = hashRecoveryCode(value);
  const user = await prisma.user.findUnique({ where: { id: input.userId }, select: { twoFactorRecoveryCodeHashes: true } });
  const hashes = Array.isArray(user?.twoFactorRecoveryCodeHashes) ? user!.twoFactorRecoveryCodeHashes.filter((v: unknown): v is string => typeof v === 'string') : [];
  if (!hashes.includes(hash)) return { ok: false as const };
  if (input.consumeRecovery !== false) {
    // Optimistic compare-and-swap prevents the same one-time recovery code from
    // succeeding twice when two requests arrive at nearly the same moment.
    const claimed = await prisma.user.updateMany({
      where: { id: input.userId, twoFactorRecoveryCodeHashes: { equals: hashes } },
      data: { twoFactorRecoveryCodeHashes: hashes.filter(v => v !== hash) },
    });
    if (claimed.count !== 1) return { ok: false as const };
  }
  return { ok: true, method: 'recovery' as const };
}
