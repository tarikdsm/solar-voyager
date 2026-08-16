import { describe, expect, it } from 'vitest';

import { AU_KM } from '../core/constants.js';
import {
  DISPLAY_REFERENCE_WHITE_NITS,
  ZODIACAL_MAX_NITS,
  ZODIACAL_PEAK_DISPLAY_RADIANCE,
  ZODIACAL_PEAK_ELONGATION_RAD,
  zodiacalLightDisplayRadiance,
  zodiacalLightScale,
} from './zodiacalLight.js';

const ONE_AU_KM = AU_KM;

describe('zodiacalLightDisplayRadiance', () => {
  it('never exceeds the 2 nit display budget anywhere on the sky', () => {
    // physics-spec.md §1.2 bounds each shape term by 1, so this is a proof by
    // exhaustion of a bound the model guarantees rather than a spot check.
    let peak = 0;
    let allFinite = true;
    for (let elongationStep = 0; elongationStep <= 1_800; elongationStep += 1) {
      const elongationRad = (elongationStep / 1_800) * Math.PI;
      for (let latitudeStep = -180; latitudeStep <= 180; latitudeStep += 1) {
        const latitudeRad = (latitudeStep / 180) * (Math.PI / 2);
        for (const distanceKm of [0.05 * ONE_AU_KM, 0.3 * ONE_AU_KM, ONE_AU_KM]) {
          const radiance = zodiacalLightDisplayRadiance(elongationRad, latitudeRad, distanceKm);
          if (!Number.isFinite(radiance)) allFinite = false;
          if (radiance > peak) peak = radiance;
        }
      }
    }
    expect(allFinite).toBe(true);
    expect(peak).toBeLessThanOrEqual(ZODIACAL_PEAK_DISPLAY_RADIANCE);
    expect(peak * DISPLAY_REFERENCE_WHITE_NITS).toBeLessThanOrEqual(ZODIACAL_MAX_NITS);
    // The budget must actually be reached, or the band is quietly invisible.
    expect(peak * DISPLAY_REFERENCE_WHITE_NITS).toBeCloseTo(ZODIACAL_MAX_NITS, 6);
  });

  it('peaks toward the Sun and in the ecliptic plane', () => {
    const inPlaneNearSun = zodiacalLightDisplayRadiance(ZODIACAL_PEAK_ELONGATION_RAD, 0, ONE_AU_KM);
    const inPlaneQuadrature = zodiacalLightDisplayRadiance(Math.PI / 2, 0, ONE_AU_KM);
    const atEclipticPole = zodiacalLightDisplayRadiance(
      ZODIACAL_PEAK_ELONGATION_RAD,
      Math.PI / 2,
      ONE_AU_KM,
    );

    expect(inPlaneNearSun).toBeGreaterThan(inPlaneQuadrature);
    expect(inPlaneNearSun).toBeGreaterThan(atEclipticPole);
    // Leinert et al. (1998) §8: roughly a factor 2.6 from ecliptic to pole.
    expect(inPlaneNearSun / atEclipticPole).toBeCloseTo(1 / 0.385, 3);
  });

  it('raises a gegenschein bump at the anti-solar point', () => {
    const antiSolar = zodiacalLightDisplayRadiance(Math.PI, 0, ONE_AU_KM);
    const beside = zodiacalLightDisplayRadiance(Math.PI - 0.9, 0, ONE_AU_KM);
    expect(antiSolar).toBeGreaterThan(beside);
  });

  it('fades with heliocentric distance and clamps inside 0.3 AU', () => {
    const atEarth = zodiacalLightDisplayRadiance(Math.PI / 2, 0, ONE_AU_KM);
    const atJupiter = zodiacalLightDisplayRadiance(Math.PI / 2, 0, 5.2 * ONE_AU_KM);
    const atNeptune = zodiacalLightDisplayRadiance(Math.PI / 2, 0, 30 * ONE_AU_KM);
    expect(atJupiter).toBeLessThan(atEarth / 40);
    expect(atNeptune).toBeLessThan(atJupiter / 50);

    const insideMercury = zodiacalLightDisplayRadiance(Math.PI / 2, 0, 0.05 * ONE_AU_KM);
    const atClamp = zodiacalLightDisplayRadiance(Math.PI / 2, 0, 0.3 * ONE_AU_KM);
    expect(insideMercury).toBe(atClamp);
  });
});

describe('zodiacalLightScale', () => {
  it('is zero when the band is switched off', () => {
    expect(zodiacalLightScale(false, ONE_AU_KM)).toBe(0);
    expect(zodiacalLightScale(false, 0)).toBe(0);
  });

  it('carries the peak radiance and the distance falloff for the shader', () => {
    expect(zodiacalLightScale(true, ONE_AU_KM)).toBeCloseTo(ZODIACAL_PEAK_DISPLAY_RADIANCE, 12);
    expect(zodiacalLightScale(true, ONE_AU_KM) * DISPLAY_REFERENCE_WHITE_NITS).toBeCloseTo(
      ZODIACAL_MAX_NITS,
      12,
    );
    // The shader multiplies this by shape*latitude, both <= 1, so the scale is
    // exactly the on-screen ceiling at that distance.
    expect(zodiacalLightScale(true, 30 * ONE_AU_KM)).toBeLessThan(
      zodiacalLightScale(true, ONE_AU_KM) / 1_000,
    );
  });
});
