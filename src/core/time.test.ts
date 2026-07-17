import { describe, expect, it } from 'vitest';

import {
  J2026_TDB_EPOCH_LABEL,
  WARP_LADDER,
  advanceSimClock,
  createSimClock,
  formatTdbSecondsAsUtc,
  tdbSecondsToUtcDate,
  tdbSecondsToUtcTimeMs,
  utcDateToTdbSeconds,
  type WarpClampState,
} from './time.js';

describe('SimClock — physics-spec.md §1 / §3.2', () => {
  it('round-trips the J2026 epoch as t=0', () => {
    const epoch = tdbSecondsToUtcDate(0);

    expect(J2026_TDB_EPOCH_LABEL).toBe('2026-01-01T00:00:00 TDB');
    expect(epoch.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(utcDateToTdbSeconds(epoch)).toBe(0);
  });

  it('round-trips positive, negative, and fractional display times', () => {
    for (const timeSec of [-86_400, 0.125, 31_536_000]) {
      expect(utcDateToTdbSeconds(tdbSecondsToUtcDate(timeSec))).toBe(timeSec);
    }
  });

  it('formats with an explicit UTC suffix independent of local timezone', () => {
    expect(formatTdbSecondsAsUtc(0)).toBe('2026-01-01 00:00:00.000 UTC');
    expect(formatTdbSecondsAsUtc(3_600)).toBe('2026-01-01 01:00:00.000 UTC');
  });

  it('maps TDB seconds to allocation-free UTC display milliseconds', () => {
    expect(tdbSecondsToUtcTimeMs(0)).toBe(Date.UTC(2026, 0, 1));
    expect(tdbSecondsToUtcTimeMs(12.5)).toBe(Date.UTC(2026, 0, 1) + 12_500);
  });

  it('advances caller-owned float64 state using the selected warp', () => {
    const clock = createSimClock(10.25);

    expect(advanceSimClock(clock, 0.5, 50)).toBe(35.25);
    expect(clock.timeSec).toBe(35.25);
  });

  it('exposes the exact warp ladder from physics-spec.md §3.2', () => {
    expect(WARP_LADDER).toEqual([1, 5, 10, 50, 100, 1e3, 1e4, 1e5, 1e6, 1e7]);
  });

  it('defines requested, effective, and reason fields for clamp state', () => {
    const clamp: WarpClampState = {
      requestedWarp: 1e5,
      effectiveWarp: 1e3,
      reason: 'substep budget',
    };

    expect(clamp).toEqual({
      requestedWarp: 1e5,
      effectiveWarp: 1e3,
      reason: 'substep budget',
    });
  });
});
