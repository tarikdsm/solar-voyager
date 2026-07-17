import { describe, expect, it } from 'vitest';

import { formatEnergyWh, formatPowerW } from './formatUnits.js';

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
});
