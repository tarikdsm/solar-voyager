import { describe, expect, it } from 'vitest';

import { norm } from '../../core/vec3.js';
import {
  createCartesianState,
  createOrbitalConversionScratch,
  createOrbitalElements,
  elementsToStateInto,
  stateToElementsInto,
  type CartesianState,
  type OrbitalElements,
} from './orbitalElements.js';

const ROUND_TRIP_RELATIVE_LIMIT = 1e-10;
const TEST_MU_KM3_S2 = 398_600;

function relativeError(actual: number, expected: number): number {
  return Math.abs(actual - expected) / Math.max(Math.abs(actual), Math.abs(expected));
}

function angularErrorRad(actual: number, expected: number): number {
  const fullTurnRad = 2 * Math.PI;
  const difference = Math.abs(actual - expected) % fullTurnRad;
  return Math.min(difference, fullTurnRad - difference);
}

function stateRelativeError(actual: CartesianState, expected: CartesianState): number {
  const dx = actual.positionKm.x - expected.positionKm.x;
  const dy = actual.positionKm.y - expected.positionKm.y;
  const dz = actual.positionKm.z - expected.positionKm.z;
  const dvx = actual.velocityKmS.x - expected.velocityKmS.x;
  const dvy = actual.velocityKmS.y - expected.velocityKmS.y;
  const dvz = actual.velocityKmS.z - expected.velocityKmS.z;
  const positionError = Math.hypot(dx, dy, dz) / norm(expected.positionKm);
  const velocityError = Math.hypot(dvx, dvy, dvz) / norm(expected.velocityKmS);
  return Math.max(positionError, velocityError);
}

function roundTripState(elements: OrbitalElements): {
  state: CartesianState;
  recovered: OrbitalElements;
  rebuilt: CartesianState;
} {
  const scratch = createOrbitalConversionScratch();
  const state = createCartesianState();
  const rebuilt = createCartesianState();
  const recovered = createOrbitalElements();

  elementsToStateInto(state, elements, TEST_MU_KM3_S2, scratch);
  stateToElementsInto(recovered, state, TEST_MU_KM3_S2);
  elementsToStateInto(rebuilt, recovered, TEST_MU_KM3_S2, scratch);
  return { state, recovered, rebuilt };
}

describe('orbital elements conversions — physics-spec.md §2 / §7.1', () => {
  it('round-trips a general inclined elliptic orbit within 1e-10 relative', () => {
    const elements: OrbitalElements = {
      semiMajorAxisKm: 18_000,
      eccentricity: 0.42,
      inclinationRad: 0.7,
      longitudeAscendingNodeRad: 1.2,
      argumentPeriapsisRad: 0.4,
      meanAnomalyRad: 2.1,
    };

    const { state, recovered, rebuilt } = roundTripState(elements);

    expect(stateRelativeError(rebuilt, state)).toBeLessThan(ROUND_TRIP_RELATIVE_LIMIT);
    expect(relativeError(recovered.semiMajorAxisKm, elements.semiMajorAxisKm)).toBeLessThan(
      ROUND_TRIP_RELATIVE_LIMIT,
    );
    expect(relativeError(recovered.eccentricity, elements.eccentricity)).toBeLessThan(
      ROUND_TRIP_RELATIVE_LIMIT,
    );
    expect(angularErrorRad(recovered.inclinationRad, elements.inclinationRad)).toBeLessThan(
      ROUND_TRIP_RELATIVE_LIMIT,
    );
    expect(
      angularErrorRad(recovered.longitudeAscendingNodeRad, elements.longitudeAscendingNodeRad),
    ).toBeLessThan(ROUND_TRIP_RELATIVE_LIMIT);
    expect(
      angularErrorRad(recovered.argumentPeriapsisRad, elements.argumentPeriapsisRad),
    ).toBeLessThan(ROUND_TRIP_RELATIVE_LIMIT);
    expect(angularErrorRad(recovered.meanAnomalyRad, elements.meanAnomalyRad)).toBeLessThan(
      ROUND_TRIP_RELATIVE_LIMIT,
    );
  });

  it('round-trips a hyperbolic orbit within 1e-10 relative', () => {
    const elements: OrbitalElements = {
      semiMajorAxisKm: -24_000,
      eccentricity: 1.7,
      inclinationRad: 0.3,
      longitudeAscendingNodeRad: 2.2,
      argumentPeriapsisRad: 0.9,
      meanAnomalyRad: -0.8,
    };

    const { state, recovered, rebuilt } = roundTripState(elements);

    expect(stateRelativeError(rebuilt, state)).toBeLessThan(ROUND_TRIP_RELATIVE_LIMIT);
    expect(relativeError(recovered.semiMajorAxisKm, elements.semiMajorAxisKm)).toBeLessThan(
      ROUND_TRIP_RELATIVE_LIMIT,
    );
    expect(relativeError(recovered.eccentricity, elements.eccentricity)).toBeLessThan(
      ROUND_TRIP_RELATIVE_LIMIT,
    );
    expect(Math.abs(recovered.meanAnomalyRad - elements.meanAnomalyRad)).toBeLessThan(
      ROUND_TRIP_RELATIVE_LIMIT,
    );
  });

  it('round-trips a near-parabolic hyperbolic state without anomaly amplification', () => {
    const elements: OrbitalElements = {
      semiMajorAxisKm: -20_000,
      eccentricity: 1.000_001,
      inclinationRad: 0.3,
      longitudeAscendingNodeRad: 0.4,
      argumentPeriapsisRad: 0.7,
      meanAnomalyRad: 10,
    };

    const { state, recovered, rebuilt } = roundTripState(elements);

    expect(Math.abs(recovered.meanAnomalyRad - elements.meanAnomalyRad)).toBeLessThan(
      ROUND_TRIP_RELATIVE_LIMIT,
    );
    expect(stateRelativeError(rebuilt, state)).toBeLessThan(ROUND_TRIP_RELATIVE_LIMIT);
  });

  it('preserves near-parabolic hyperbolic energy at and near periapsis', () => {
    const cases: OrbitalElements[] = [
      {
        semiMajorAxisKm: -1e9,
        eccentricity: 1.000_001,
        inclinationRad: 0.3,
        longitudeAscendingNodeRad: 2.2,
        argumentPeriapsisRad: 0.9,
        meanAnomalyRad: -1e-9,
      },
      {
        semiMajorAxisKm: -1e12,
        eccentricity: 1 + 1e-9,
        inclinationRad: 0.3,
        longitudeAscendingNodeRad: 2.2,
        argumentPeriapsisRad: 0.9,
        meanAnomalyRad: 0,
      },
    ];

    for (const elements of cases) {
      const { state, recovered, rebuilt } = roundTripState(elements);

      expect(recovered.eccentricity).toBeGreaterThan(1);
      expect(recovered.semiMajorAxisKm).toBeLessThan(0);
      expect(stateRelativeError(rebuilt, state)).toBeLessThan(ROUND_TRIP_RELATIVE_LIMIT);
    }
  });

  it('round-trips states at the specified eccentricity range boundaries', () => {
    const boundaryCases: OrbitalElements[] = [
      {
        semiMajorAxisKm: 50_000,
        eccentricity: 0.99,
        inclinationRad: 1.1,
        longitudeAscendingNodeRad: 0.2,
        argumentPeriapsisRad: 2.4,
        meanAnomalyRad: 0.1,
      },
      {
        semiMajorAxisKm: -20_000,
        eccentricity: 5,
        inclinationRad: 0.9,
        longitudeAscendingNodeRad: 1.7,
        argumentPeriapsisRad: 0.2,
        meanAnomalyRad: 3,
      },
    ];

    for (const elements of boundaryCases) {
      const { state, rebuilt } = roundTripState(elements);

      expect(stateRelativeError(rebuilt, state)).toBeLessThan(ROUND_TRIP_RELATIVE_LIMIT);
    }
  });

  it('canonicalizes a circular equatorial orbit without losing physical longitude', () => {
    const elements: OrbitalElements = {
      semiMajorAxisKm: 7_000,
      eccentricity: 0,
      inclinationRad: 0,
      longitudeAscendingNodeRad: 0.6,
      argumentPeriapsisRad: 0.9,
      meanAnomalyRad: 1.1,
    };

    const { state, recovered, rebuilt } = roundTripState(elements);

    expect(recovered.longitudeAscendingNodeRad).toBe(0);
    expect(recovered.argumentPeriapsisRad).toBe(0);
    expect(stateRelativeError(rebuilt, state)).toBeLessThan(ROUND_TRIP_RELATIVE_LIMIT);
  });

  it('canonicalizes a circular inclined orbit without losing argument of latitude', () => {
    const elements: OrbitalElements = {
      semiMajorAxisKm: 9_000,
      eccentricity: 0,
      inclinationRad: 0.8,
      longitudeAscendingNodeRad: 1.4,
      argumentPeriapsisRad: 0.5,
      meanAnomalyRad: 2.3,
    };

    const { state, recovered, rebuilt } = roundTripState(elements);

    expect(recovered.argumentPeriapsisRad).toBe(0);
    expect(stateRelativeError(rebuilt, state)).toBeLessThan(ROUND_TRIP_RELATIVE_LIMIT);
  });

  it('canonicalizes an eccentric equatorial orbit without losing periapsis longitude', () => {
    const elements: OrbitalElements = {
      semiMajorAxisKm: 11_000,
      eccentricity: 0.35,
      inclinationRad: 0,
      longitudeAscendingNodeRad: 1.2,
      argumentPeriapsisRad: 0.8,
      meanAnomalyRad: 1.6,
    };

    const { state, recovered, rebuilt } = roundTripState(elements);

    expect(recovered.longitudeAscendingNodeRad).toBe(0);
    expect(stateRelativeError(rebuilt, state)).toBeLessThan(ROUND_TRIP_RELATIVE_LIMIT);
  });

  it('preserves a near-equatorial inclination without acos cancellation', () => {
    const elements: OrbitalElements = {
      semiMajorAxisKm: 16_000,
      eccentricity: 0.2,
      inclinationRad: 1e-8,
      longitudeAscendingNodeRad: 0,
      argumentPeriapsisRad: 0.7,
      meanAnomalyRad: 10,
    };

    const { state, recovered, rebuilt } = roundTripState(elements);

    expect(Math.abs(recovered.inclinationRad - elements.inclinationRad)).toBeLessThan(
      ROUND_TRIP_RELATIVE_LIMIT,
    );
    expect(recovered.longitudeAscendingNodeRad).toBeGreaterThanOrEqual(0);
    expect(recovered.longitudeAscendingNodeRad).toBeLessThan(2 * Math.PI);
    expect(stateRelativeError(rebuilt, state)).toBeLessThan(ROUND_TRIP_RELATIVE_LIMIT);
  });

  it('canonicalizes a retrograde equatorial orbit without flipping it prograde', () => {
    const elements: OrbitalElements = {
      semiMajorAxisKm: 14_000,
      eccentricity: 0.2,
      inclinationRad: Math.PI,
      longitudeAscendingNodeRad: 1.1,
      argumentPeriapsisRad: 0.4,
      meanAnomalyRad: 2,
    };

    const { state, recovered, rebuilt } = roundTripState(elements);

    expect(recovered.inclinationRad).toBe(Math.PI);
    expect(recovered.longitudeAscendingNodeRad).toBe(0);
    expect(stateRelativeError(rebuilt, state)).toBeLessThan(ROUND_TRIP_RELATIVE_LIMIT);
  });

  it('writes into caller-owned state and element outputs', () => {
    const scratch = createOrbitalConversionScratch();
    const state = createCartesianState();
    const recovered = createOrbitalElements();
    const elements: OrbitalElements = {
      semiMajorAxisKm: 12_000,
      eccentricity: 0.2,
      inclinationRad: 0.4,
      longitudeAscendingNodeRad: 0.3,
      argumentPeriapsisRad: 0.7,
      meanAnomalyRad: 1,
    };

    expect(elementsToStateInto(state, elements, TEST_MU_KM3_S2, scratch)).toBe(state);
    expect(stateToElementsInto(recovered, state, TEST_MU_KM3_S2)).toBe(recovered);
  });
});
