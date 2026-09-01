import { describe, expect, it } from 'vitest';
import { scoreAccountRisk } from '../src/services/risk-score.service';

describe('SANDMAN account risk scoring', () => {
  const now = new Date('2026-09-01T12:00:00Z');

  it('keeps an established verified account low risk', () => {
    const result = scoreAccountRisk({
      createdAt: new Date('2025-09-01T12:00:00Z'),
      emailVerified: true,
      phoneVerified: true,
      twoFactorEnabled: true,
      failedLogins7d: 0,
      newDeviceLogins7d: 1,
      openReports: 0,
    }, now);
    expect(result).toEqual({ score: 0, level: 'LOW', reasons: [] });
  });

  it('marks a very new, unverified and repeatedly reported account high risk', () => {
    const result = scoreAccountRisk({
      createdAt: new Date('2026-09-01T08:00:00Z'),
      emailVerified: false,
      phoneVerified: false,
      twoFactorEnabled: false,
      failedLogins7d: 3,
      newDeviceLogins7d: 5,
      openReports: 2,
    }, now);
    expect(result.level).toBe('HIGH');
    expect(result.score).toBe(100);
    expect(result.reasons.length).toBeGreaterThan(4);
  });
});
