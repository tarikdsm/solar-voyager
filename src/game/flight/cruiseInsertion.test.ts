import { describe, expect, it } from 'vitest';

import {
  circularSpeedKmS,
  osculatingEccentricity,
  writeEclipticTangentInto,
  writeOsculatingTangentInto,
} from './cruiseInsertion.js';

const JUPITER_MU_KM3S2 = 1.26686534e8;
const JUPITER_ARRIVAL_RADIUS_KM = 324_000;

describe('circularSpeedKmS', () => {
  it('matches sqrt(mu/r) at the Jupiter stand-off', () => {
    expect(circularSpeedKmS(JUPITER_MU_KM3S2, JUPITER_ARRIVAL_RADIUS_KM)).toBeCloseTo(
      Math.sqrt(JUPITER_MU_KM3S2 / JUPITER_ARRIVAL_RADIUS_KM),
      12,
    );
  });

  it('rejects degenerate arguments rather than returning a signed infinity', () => {
    expect(Number.isNaN(circularSpeedKmS(0, 1))).toBe(true);
    expect(Number.isNaN(circularSpeedKmS(1, 0))).toBe(true);
  });
});

describe('osculatingEccentricity', () => {
  it('is zero for an exactly circular state', () => {
    const radiusKm = JUPITER_ARRIVAL_RADIUS_KM;
    const speed = Math.sqrt(JUPITER_MU_KM3S2 / radiusKm);
    const position = new Float64Array([radiusKm, 0, 0]);
    const velocity = new Float64Array([0, speed, 0]);
    expect(osculatingEccentricity(position, velocity, JUPITER_MU_KM3S2)).toBeLessThan(1e-15);
  });

  it('is one for a purely radial free fall', () => {
    const position = new Float64Array([JUPITER_ARRIVAL_RADIUS_KM, 0, 0]);
    const velocity = new Float64Array([0, 0, 0]);
    expect(osculatingEccentricity(position, velocity, JUPITER_MU_KM3S2)).toBeCloseTo(1, 12);
  });

  it('reproduces the closed form for a known ellipse', () => {
    // Apoapsis of an e = 0.25 ellipse: r_a = a(1+e), v_a = sqrt(mu/a * (1-e)/(1+e)).
    const semiMajorAxisKm = 400_000;
    const eccentricity = 0.25;
    const apoapsisKm = semiMajorAxisKm * (1 + eccentricity);
    const speed = Math.sqrt(
      (JUPITER_MU_KM3S2 / semiMajorAxisKm) * ((1 - eccentricity) / (1 + eccentricity)),
    );
    const position = new Float64Array([0, apoapsisKm, 0]);
    const velocity = new Float64Array([-speed, 0, 0]);
    expect(osculatingEccentricity(position, velocity, JUPITER_MU_KM3S2)).toBeCloseTo(
      eccentricity,
      12,
    );
  });
});

describe('insertion tangents', () => {
  it('writes a unit tangent perpendicular to the radius and to the ecliptic pole', () => {
    const position = new Float64Array([3, 4, 5]);
    const tangent = new Float64Array(3);
    writeEclipticTangentInto(tangent, position);
    expect(Math.hypot(...tangent)).toBeCloseTo(1, 15);
    expect(
      (tangent[0] as number) * 3 + (tangent[1] as number) * 4 + (tangent[2] as number) * 5,
    ).toBeCloseTo(0, 12);
    expect(tangent[2]).toBe(0);
  });

  it('falls back to a polar-safe basis directly over the pole', () => {
    const tangent = new Float64Array(3);
    writeEclipticTangentInto(tangent, new Float64Array([0, 0, 1_000]));
    expect(Math.hypot(...tangent)).toBeCloseTo(1, 15);
    expect(tangent[2]).toBeCloseTo(0, 15);
  });

  it('follows the achieved plane when angular momentum exists', () => {
    const position = new Float64Array([1_000, 0, 0]);
    const velocity = new Float64Array([3, 0, 7]);
    const tangent = new Float64Array(3);
    writeOsculatingTangentInto(tangent, position, velocity);
    expect(Math.hypot(...tangent)).toBeCloseTo(1, 15);
    expect(tangent[0]).toBeCloseTo(0, 15);
    expect(tangent[2]).toBeCloseTo(1, 15);
  });

  it('falls back to the ecliptic tangent for radial motion', () => {
    const position = new Float64Array([1_000, 0, 0]);
    const radial = new Float64Array([-5, 0, 0]);
    const osculating = new Float64Array(3);
    const ecliptic = new Float64Array(3);
    writeOsculatingTangentInto(osculating, position, radial);
    writeEclipticTangentInto(ecliptic, position);
    expect(Array.from(osculating)).toEqual(Array.from(ecliptic));
  });
});
