import { describe, expect, it } from 'vitest';

import { STANDARD_GRAVITY_M_S2 } from './thrust.js';
import { DEFAULT_VESSEL, validateVesselConfig, type VesselConfig } from './vessel.js';

function config(overrides: Partial<VesselConfig> = {}): VesselConfig {
  return { ...DEFAULT_VESSEL, ...overrides };
}

describe('VesselConfig — ADR-034', () => {
  it('defaults to the 10 t torchship at 10 g absolute, 2 g manual, 15 deg/s slew', () => {
    expect(DEFAULT_VESSEL.restMassKg).toBe(10_000);
    expect(DEFAULT_VESSEL.alphaMaxMS2).toBe(98.0665);
    expect(DEFAULT_VESSEL.alphaManualMaxMS2).toBe(19.6133);
    expect(DEFAULT_VESSEL.maxSlewRadPerSimS).toBe(0.261799);

    // The literals are exactly 10 g and 2 g to the precision the plan specifies.
    expect(DEFAULT_VESSEL.alphaMaxMS2 / STANDARD_GRAVITY_M_S2).toBeCloseTo(10, 12);
    expect(DEFAULT_VESSEL.alphaManualMaxMS2 / STANDARD_GRAVITY_M_S2).toBeCloseTo(2, 12);
    expect((DEFAULT_VESSEL.maxSlewRadPerSimS * 180) / Math.PI).toBeCloseTo(15, 4);
  });

  it('is frozen and survives validation unchanged', () => {
    expect(Object.isFrozen(DEFAULT_VESSEL)).toBe(true);
    expect(validateVesselConfig(DEFAULT_VESSEL)).toEqual(DEFAULT_VESSEL);
    expect(Object.isFrozen(validateVesselConfig(config()))).toBe(true);
  });

  it('copies rather than aliasing the source object', () => {
    const mutable = { ...DEFAULT_VESSEL, restMassKg: 5_000 };
    const validated = validateVesselConfig(mutable);
    mutable.restMassKg = 1;

    expect(validated.restMassKg).toBe(5_000);
    expect(validated).not.toBe(mutable);
  });

  it('rejects non-finite and non-positive quantities', () => {
    expect(() => validateVesselConfig(config({ restMassKg: 0 }))).toThrow(/rest mass/u);
    expect(() => validateVesselConfig(config({ restMassKg: -1 }))).toThrow(/rest mass/u);
    expect(() => validateVesselConfig(config({ restMassKg: Number.NaN }))).toThrow(/rest mass/u);
    expect(() => validateVesselConfig(config({ alphaMaxMS2: 0 }))).toThrow(
      /maximum proper acceleration/u,
    );
    expect(() => validateVesselConfig(config({ alphaMaxMS2: Number.POSITIVE_INFINITY }))).toThrow(
      /maximum proper acceleration/u,
    );
    expect(() => validateVesselConfig(config({ alphaManualMaxMS2: 0 }))).toThrow(
      /manual proper acceleration/u,
    );
    expect(() => validateVesselConfig(config({ maxSlewRadPerSimS: 0 }))).toThrow(
      /maximum slew rate/u,
    );
  });

  it('rejects a manual regime above the absolute drive limit', () => {
    expect(() =>
      validateVesselConfig(config({ alphaMaxMS2: 19.6133, alphaManualMaxMS2: 98.0665 })),
    ).toThrow(/must not exceed the drive limit/u);
    // Equal is allowed: a vessel whose manual regime is its whole envelope.
    expect(
      validateVesselConfig(config({ alphaMaxMS2: 19.6133, alphaManualMaxMS2: 19.6133 }))
        .alphaManualMaxMS2,
    ).toBe(19.6133);
  });
});
