export type AccountRiskInput = {
  createdAt: Date;
  emailVerified: boolean;
  phoneVerified: boolean;
  twoFactorEnabled: boolean;
  failedLogins7d: number;
  newDeviceLogins7d: number;
  openReports: number;
  impersonationSignals7d?: number;
};

export type AccountRisk = {
  score: number;
  level: 'LOW' | 'MEDIUM' | 'HIGH';
  reasons: string[];
};

export function scoreAccountRisk(input: AccountRiskInput, now = new Date()): AccountRisk {
  let score = 0;
  const reasons: string[] = [];
  const ageMs = Math.max(0, now.getTime() - input.createdAt.getTime());
  const day = 86_400_000;

  if (ageMs < day) { score += 20; reasons.push('Account created in the last 24 hours'); }
  else if (ageMs < 7 * day) { score += 10; reasons.push('Account created in the last 7 days'); }

  if (!input.emailVerified) { score += 15; reasons.push('Email is not verified'); }
  if (!input.phoneVerified) { score += 5; reasons.push('Phone is not verified'); }
  if (!input.twoFactorEnabled) { score += 5; reasons.push('2FA is not enabled'); }

  if (input.failedLogins7d > 0) {
    const points = Math.min(30, input.failedLogins7d * 5);
    score += points;
    reasons.push(`${input.failedLogins7d} failed sign-in attempt${input.failedLogins7d === 1 ? '' : 's'} in 7 days`);
  }

  if (input.newDeviceLogins7d >= 4) {
    const points = Math.min(15, (input.newDeviceLogins7d - 3) * 5);
    score += points;
    reasons.push(`${input.newDeviceLogins7d} new-device sign-ins in 7 days`);
  }

  if ((input.impersonationSignals7d || 0) > 0) {
    const count = input.impersonationSignals7d || 0;
    score += Math.min(40, count * 30);
    reasons.push(`${count} possible impersonation signal${count === 1 ? '' : 's'} in 7 days`);
  }

  if (input.openReports > 0) {
    const points = Math.min(50, input.openReports * 25);
    score += points;
    reasons.push(`${input.openReports} unresolved user report${input.openReports === 1 ? '' : 's'}`);
  }

  score = Math.min(100, score);
  return { score, level: score >= 50 ? 'HIGH' : score >= 25 ? 'MEDIUM' : 'LOW', reasons };
}
