import { describe, expect, test } from 'vitest';

import { DEFAULT_VESSEL } from '../sim/ship/vessel.js';

import {
  addMagnitudes,
  beamIntensity,
  beamLengthShipLengths,
  plumeApparentMagnitude,
  plumeRadiantIntensityWPerSr,
  PLUME_ISOTROPIC_FRACTION,
  PLUME_LOBE_EXPONENT,
  SOLAR_LUMINOSITY_W,
} from './plumeRadiance.js';
import { SHIP_BOUNDING_RADIUS_KM, SHIP_HULL_GEOMETRIC_ALBEDO } from './shipVisual.js';
import { apparentMagnitude } from './visualTier.js';

const SPEED_OF_LIGHT_MS = 299_792_458;
const AU_KM = 149_597_870.7;
/** physics-spec §5: a photon rocket radiates `P = m·alpha·c`. */
const FULL_THROTTLE_POWER_W =
  DEFAULT_VESSEL.restMassKg * DEFAULT_VESSEL.alphaMaxMS2 * SPEED_OF_LIGHT_MS;

describe('plume beam pattern', () => {
  test('integrates to the drive power over the sphere', () => {
    // Gauss-Legendre would be overkill; the pattern is smooth in cos(theta), so
    // a fine midpoint rule over mu = cos(theta) converges quickly.
    const steps = 200_000;
    let total = 0;
    for (let index = 0; index < steps; index += 1) {
      const mu = -1 + ((index + 0.5) * 2) / steps;
      total += plumeRadiantIntensityWPerSr(1, mu) * (2 / steps) * 2 * Math.PI;
    }
    expect(total).toBeCloseTo(1, 4);
  });

  test('splits exactly into the documented isotropic and lobe terms on axis', () => {
    const onAxis = plumeRadiantIntensityWPerSr(1, 1);
    const expected =
      PLUME_ISOTROPIC_FRACTION / (4 * Math.PI) +
      ((1 - PLUME_ISOTROPIC_FRACTION) * (PLUME_LOBE_EXPONENT + 1)) / (2 * Math.PI);
    expect(onAxis).toBeCloseTo(expected, 12);
  });

  test('is the bare isotropic floor at and behind the beam waist', () => {
    const floor = PLUME_ISOTROPIC_FRACTION / (4 * Math.PI);
    expect(plumeRadiantIntensityWPerSr(1, 0)).toBeCloseTo(floor, 12);
    expect(plumeRadiantIntensityWPerSr(1, -1)).toBeCloseTo(floor, 12);
  });

  test('half-power half-angle of the lobe is 8.42 degrees', () => {
    const halfAngleRad = Math.acos(Math.pow(0.5, 1 / PLUME_LOBE_EXPONENT));
    expect((halfAngleRad * 180) / Math.PI).toBeCloseTo(8.417, 3);
    const lobeOnly = (cosine: number): number =>
      plumeRadiantIntensityWPerSr(1, cosine) - PLUME_ISOTROPIC_FRACTION / (4 * Math.PI);
    expect(lobeOnly(Math.cos(halfAngleRad))).toBeCloseTo(lobeOnly(1) / 2, 12);
  });

  test('is zero for a dark drive and for a non-finite angle', () => {
    expect(plumeRadiantIntensityWPerSr(0, 1)).toBe(0);
    expect(plumeRadiantIntensityWPerSr(-1, 1)).toBe(0);
    expect(plumeRadiantIntensityWPerSr(1, Number.NaN)).toBe(0);
  });
});

describe('plume apparent magnitude', () => {
  test('the default vessel radiates 7.68e-13 solar luminosities', () => {
    expect(FULL_THROTTLE_POWER_W / SOLAR_LUMINOSITY_W).toBeCloseTo(7.68e-13, 15);
  });

  // The design table in docs/superpowers/specs/2026-08-16-ship-vfx-design.md §2.
  test.each([
    ['down the beam at 1 AU', 1, AU_KM, -1.7],
    ['side-on at 1 AU', 0, AU_KM, 7.8],
    ['side-on at 10 AU', 0, 10 * AU_KM, 12.8],
  ])('%s is magnitude %s', (_label, cosine, distanceKm, expected) => {
    expect(plumeApparentMagnitude(FULL_THROTTLE_POWER_W, cosine, distanceKm)).toBeCloseTo(
      expected,
      1,
    );
  });

  test('a burning ship is 16 magnitudes brighter than a coasting one at 1 AU', () => {
    const positionsKm = new Float64Array([0, 0, 0, AU_KM, 0, 0]);
    const reflected = apparentMagnitude(
      1,
      0,
      SHIP_BOUNDING_RADIUS_KM,
      SHIP_HULL_GEOMETRIC_ALBEDO,
      positionsKm,
      { x: 0, y: 0, z: 0 },
    );
    const burning = plumeApparentMagnitude(FULL_THROTTLE_POWER_W, 0, AU_KM);
    expect(reflected).toBeCloseTo(24.4, 1);
    expect(reflected - burning).toBeGreaterThan(16);
  });

  test('follows the inverse-square law exactly', () => {
    const near = plumeApparentMagnitude(FULL_THROTTLE_POWER_W, 0.5, 1e6);
    const far = plumeApparentMagnitude(FULL_THROTTLE_POWER_W, 0.5, 1e7);
    expect(far - near).toBeCloseTo(5, 10);
  });

  test('a dark drive is infinitely faint rather than an error', () => {
    expect(plumeApparentMagnitude(0, 1, AU_KM)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('flux addition', () => {
  test('two equal magnitudes combine to 0.7526 brighter', () => {
    expect(addMagnitudes(5, 5)).toBeCloseTo(5 - 2.5 * Math.log10(2), 12);
  });

  test('an infinitely faint term leaves the other untouched', () => {
    expect(addMagnitudes(12.25, Number.POSITIVE_INFINITY)).toBeCloseTo(12.25, 12);
    expect(addMagnitudes(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY)).toBe(
      Number.POSITIVE_INFINITY,
    );
  });

  test('is dominated by the brighter term', () => {
    expect(addMagnitudes(1, 21)).toBeCloseTo(1, 6);
  });

  test('is commutative and monotonic in each argument', () => {
    expect(addMagnitudes(3, 9)).toBeCloseTo(addMagnitudes(9, 3), 12);
    expect(addMagnitudes(3, 8)).toBeLessThan(addMagnitudes(3, 9));
  });
});

describe('beam length and intensity curves', () => {
  test('reaches four ship lengths at full throttle and zero when coasting', () => {
    expect(beamLengthShipLengths(1)).toBeCloseTo(4, 12);
    expect(beamLengthShipLengths(0)).toBe(0);
    expect(beamLengthShipLengths(-0.2)).toBe(0);
  });

  test('uses the plan §3.6 throttle exponent of 0.7', () => {
    expect(beamLengthShipLengths(0.5)).toBeCloseTo(4 * Math.pow(0.5, 0.7), 12);
    expect(beamLengthShipLengths(0.25)).toBeCloseTo(4 * Math.pow(0.25, 0.7), 12);
  });

  test('clamps above full throttle instead of extrapolating', () => {
    expect(beamLengthShipLengths(4)).toBeCloseTo(4, 12);
    expect(beamIntensity(4)).toBeCloseTo(1, 12);
  });

  test('brightness rises more slowly than length at low throttle', () => {
    expect(beamIntensity(0.04)).toBeCloseTo(0.2, 12);
    expect(beamIntensity(0)).toBe(0);
    expect(beamIntensity(Number.NaN)).toBe(0);
  });
});
