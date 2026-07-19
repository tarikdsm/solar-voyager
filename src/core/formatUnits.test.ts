import { describe, expect, it } from 'vitest';

import {
  formatBodyId,
  formatDurationSec,
  formatEnergyWh,
  formatPowerW,
  formatProperDeltaV,
  formatSignedDeltaV,
  formatUtcTimeMs,
} from './formatUnits.js';

describe('energy HUD formatters — physics-spec.md §5', () => {
  it('formats joules as three-significant-digit watt-hours', () => {
    expect(formatEnergyWh(0)).toBe('0 Wh');
    expect(formatEnergyWh(3_600)).toBe('1.00 Wh');
    expect(formatEnergyWh(4.82e15 * 3_600)).toBe('4.82 PWh');
    expect(formatEnergyWh(999.4 * 3_600)).toBe('999 Wh');
    expect(formatEnergyWh(999.6 * 3_600)).toBe('1.00 kWh');
  });

  it('formats power through the complete SI prefix ladder and clamps at yotta', () => {
    expect(formatPowerW(12_345)).toBe('12.3 kW');
    expect(formatPowerW(1e24)).toBe('1.00 YW');
    expect(formatPowerW(1e27)).toBe('1000 YW');
  });

  it('rejects non-finite or negative physical totals', () => {
    expect(() => formatEnergyWh(-1)).toThrow(/energy/u);
    expect(() => formatPowerW(Number.NaN)).toThrow(/power/u);
  });

  it('shares deterministic burn-log labels and physical readouts', () => {
    expect(formatDurationSec(90_061.25)).toBe('1d 01:01:01.250');
    expect(formatUtcTimeMs(Date.UTC(2026, 6, 17, 12, 30, 45, 6))).toBe(
      '2026-07-17 12:30:45.006 UTC',
    );
    expect(formatBodyId('alpha-centauri')).toBe('Alpha Centauri');
    expect(formatBodyId(null)).toBe('—');
    expect(formatProperDeltaV(1)).toBe('1 m/s');
    expect(formatProperDeltaV(12.5)).toBe('12.5 m/s');
    expect(formatProperDeltaV(0.001_23)).toBe('0.00123 m/s');
    expect(formatProperDeltaV(999.6)).toBe('1,000 m/s');
    expect(formatProperDeltaV(1_000)).toBe('1 km/s');
    expect(formatProperDeltaV(999_600)).toBe('1,000 km/s');
    expect(formatSignedDeltaV(10)).toBe('+10.0 m/s');
    expect(formatSignedDeltaV(-2.5)).toBe('-2.50 m/s');
    expect(formatSignedDeltaV(0.001_23)).toBe('+0.00123 m/s');
    expect(formatSignedDeltaV(0)).toBe('0 m/s');
  });
});
