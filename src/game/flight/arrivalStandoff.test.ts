import { describe, expect, it } from 'vitest';

import ringsDocument from '../../../data/rings.json';

import {
  orbitArrivalAltitudeKm,
  orbitArrivalRadiusKm,
  RING_ARRIVAL_MARGIN,
  SOLAR_ARRIVAL_RADII,
} from './arrivalStandoff.js';

const SUN_COLLISION_RADIUS_KM = 695_700;
const JUPITER_COLLISION_RADIUS_KM = 71_492;
const SATURN_COLLISION_RADIUS_KM = 60_268;
const URANUS_COLLISION_RADIUS_KM = 25_559;
const NEPTUNE_COLLISION_RADIUS_KM = 24_764;
const MARS_COLLISION_RADIUS_KM = 3_389.5;

describe('orbitArrivalRadiusKm', () => {
  it('reproduces the physics-spec §8.5 ringed-giant table', () => {
    expect(orbitArrivalRadiusKm('jupiter', JUPITER_COLLISION_RADIUS_KM)).toBeCloseTo(324_000, 6);
    expect(orbitArrivalRadiusKm('saturn', SATURN_COLLISION_RADIUS_KM)).toBeCloseTo(168_734.4, 6);
    expect(orbitArrivalRadiusKm('uranus', URANUS_COLLISION_RADIUS_KM)).toBeCloseTo(127_440, 6);
    expect(orbitArrivalRadiusKm('neptune', NEPTUNE_COLLISION_RADIUS_KM)).toBeCloseTo(75_528.6, 6);
  });

  it('keeps Jupiter outside the Thebe gossamer ring, which 3 R_col does not', () => {
    const thebeOuterKm = ringsDocument.systems.find((s) => s.bodyId === 'jupiter')?.outerRadiusKm;
    expect(thebeOuterKm).toBe(270_000);
    expect(3 * JUPITER_COLLISION_RADIUS_KM).toBeLessThan(thebeOuterKm as number);
    expect(orbitArrivalRadiusKm('jupiter', JUPITER_COLLISION_RADIUS_KM)).toBeGreaterThan(
      thebeOuterKm as number,
    );
  });

  it('places the Sun stand-off at 25 solar radii', () => {
    expect(orbitArrivalRadiusKm('sun', SUN_COLLISION_RADIUS_KM)).toBe(17_392_500);
    expect(SOLAR_ARRIVAL_RADII).toBe(25);
  });

  it('leaves unringed bodies on the solver default of 3 R_col', () => {
    expect(orbitArrivalRadiusKm('mars', MARS_COLLISION_RADIUS_KM)).toBe(
      3 * MARS_COLLISION_RADIUS_KM,
    );
    expect(orbitArrivalAltitudeKm('mars', MARS_COLLISION_RADIUS_KM)).toBe(0);
  });

  it('expresses overrides as an altitude above the collision sphere', () => {
    expect(orbitArrivalAltitudeKm('jupiter', JUPITER_COLLISION_RADIUS_KM)).toBeCloseTo(252_508, 6);
    expect(orbitArrivalAltitudeKm('saturn', SATURN_COLLISION_RADIUS_KM)).toBeCloseTo(108_466.4, 6);
    expect(orbitArrivalAltitudeKm('uranus', URANUS_COLLISION_RADIUS_KM)).toBeCloseTo(101_881, 6);
    expect(orbitArrivalAltitudeKm('neptune', NEPTUNE_COLLISION_RADIUS_KM)).toBeCloseTo(50_764.6, 6);
    expect(orbitArrivalAltitudeKm('sun', SUN_COLLISION_RADIUS_KM)).toBe(
      17_392_500 - SUN_COLLISION_RADIUS_KM,
    );
  });

  it('uses the shipped ring data rather than transcribed constants', () => {
    for (const system of ringsDocument.systems) {
      expect(orbitArrivalRadiusKm(system.bodyId, system.referenceRadiusKm)).toBeCloseTo(
        RING_ARRIVAL_MARGIN * system.outerRadiusKm,
        6,
      );
    }
  });

  it('lets the ring rule override the 3 R_col default in both directions', () => {
    // physics-spec §8.5 puts Saturn at 2.80 R_col, deliberately inside the
    // default: the outermost ring sets the bar, not the body radius.
    expect(orbitArrivalRadiusKm('saturn', SATURN_COLLISION_RADIUS_KM)).toBeLessThan(
      3 * SATURN_COLLISION_RADIUS_KM,
    );
    expect(orbitArrivalRadiusKm('jupiter', JUPITER_COLLISION_RADIUS_KM)).toBeGreaterThan(
      3 * JUPITER_COLLISION_RADIUS_KM,
    );
  });

  it('rejects a body with no radius', () => {
    expect(orbitArrivalRadiusKm('unknown-body', 100)).toBe(300);
    expect(Number.isNaN(orbitArrivalRadiusKm('mars', 0))).toBe(true);
    expect(Number.isNaN(orbitArrivalAltitudeKm('mars', Number.NaN))).toBe(true);
  });
});
