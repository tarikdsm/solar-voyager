import { describe, expect, it } from 'vitest';

import { SPEED_OF_LIGHT_KM_S } from '../../../src/core/constants.js';
import {
  relativisticStopCoordSec,
  relativisticStopDistanceKm,
} from '../../../src/sim/guidance/brakingEnvelope.js';

/**
 * Analytic truth, written independently of the implementation and in a different
 * algebra: with rapidity `w = atanh(beta)`, `gamma = cosh w`, so
 * `gamma - 1 = 2 sinh²(w/2)`. That half-angle form is well conditioned over the
 * whole subluminal range, whereas the textbook `1/sqrt(1-beta²) - 1` cancels away
 * every significant digit below beta ~ 1e-4 and returns a flat zero by 1e-8.
 */
function exactStopDistanceKm(relSpeedKmS: number, alphaMS2: number): number {
  const halfRapidity = Math.atanh(relSpeedKmS / SPEED_OF_LIGHT_KM_S) / 2;
  const lorentzExcess = 2 * Math.sinh(halfRapidity) * Math.sinh(halfRapidity);
  return ((SPEED_OF_LIGHT_KM_S * SPEED_OF_LIGHT_KM_S) / (alphaMS2 / 1_000)) * lorentzExcess;
}

function relativeError(actual: number, expected: number): number {
  return Math.abs(actual - expected) / Math.max(Math.abs(actual), Math.abs(expected));
}

const ALPHA_TEN_G_MS2 = 98.0665;

describe('braking envelope — physics-spec §8.3', () => {
  it('matches the exact (c²/α)(γ−1) form across the subluminal range', () => {
    const betas = [1e-9, 1e-6, 1e-4, 1e-3, 0.01, 0.1, 0.25, 0.5, 0.9, 0.99, 0.999];
    for (const beta of betas) {
      const speedKmS = beta * SPEED_OF_LIGHT_KM_S;
      for (const alphaMS2 of [9.80665, 98.0665, 19.6133]) {
        expect(
          relativeError(
            relativisticStopDistanceKm(speedKmS, alphaMS2),
            exactStopDistanceKm(speedKmS, alphaMS2),
          ),
        ).toBeLessThan(1e-12);
      }
    }
  });

  it('keeps precision where the textbook 1/√(1−β²)−1 form has none left', () => {
    // At beta = 1e-9 the naive difference underflows to exactly zero; the envelope
    // is 1e-18/2 of c²/alpha and must still be reported.
    const speedKmS = 1e-9 * SPEED_OF_LIGHT_KM_S;
    const naiveGammaExcess = 1 / Math.sqrt(1 - (speedKmS / SPEED_OF_LIGHT_KM_S) ** 2) - 1;
    expect(naiveGammaExcess).toBe(0);
    expect(
      relativeError(
        relativisticStopDistanceKm(speedKmS, ALPHA_TEN_G_MS2),
        (speedKmS * speedKmS) / (2 * (ALPHA_TEN_G_MS2 / 1_000)),
      ),
    ).toBeLessThan(1e-15);
  });

  it('reduces to the Newtonian v²/(2α) at low speed', () => {
    const speedKmS = 30;
    const newtonianKm = (speedKmS * speedKmS) / (2 * (ALPHA_TEN_G_MS2 / 1_000));
    expect(
      relativeError(relativisticStopDistanceKm(speedKmS, ALPHA_TEN_G_MS2), newtonianKm),
    ).toBeLessThan(1e-8);
  });

  it('always exceeds the Newtonian estimate, and by more the faster it goes', () => {
    let previousExcess = 0;
    for (const beta of [1e-3, 0.01, 0.1, 0.5, 0.9]) {
      const speedKmS = beta * SPEED_OF_LIGHT_KM_S;
      const newtonianKm = (speedKmS * speedKmS) / (2 * (ALPHA_TEN_G_MS2 / 1_000));
      const excess = relativisticStopDistanceKm(speedKmS, ALPHA_TEN_G_MS2) / newtonianKm - 1;
      expect(excess).toBeGreaterThan(previousExcess);
      previousExcess = excess;
    }
  });

  it('is a magnitude, so the sign of the closing speed does not matter', () => {
    expect(relativisticStopDistanceKm(-1_234, ALPHA_TEN_G_MS2)).toBe(
      relativisticStopDistanceKm(1_234, ALPHA_TEN_G_MS2),
    );
    expect(relativisticStopDistanceKm(0, ALPHA_TEN_G_MS2)).toBe(0);
    expect(relativisticStopCoordSec(0, ALPHA_TEN_G_MS2)).toBe(0);
  });

  it('reports an unbounded envelope when the ship cannot brake', () => {
    expect(relativisticStopDistanceKm(30, 0)).toBe(Number.POSITIVE_INFINITY);
    expect(relativisticStopDistanceKm(30, -1)).toBe(Number.POSITIVE_INFINITY);
    expect(relativisticStopCoordSec(30, 0)).toBe(Number.POSITIVE_INFINITY);
    expect(relativisticStopDistanceKm(SPEED_OF_LIGHT_KM_S, ALPHA_TEN_G_MS2)).toBe(
      Number.POSITIVE_INFINITY,
    );
    expect(relativisticStopCoordSec(SPEED_OF_LIGHT_KM_S, ALPHA_TEN_G_MS2)).toBe(
      Number.POSITIVE_INFINITY,
    );
  });

  it('returns NaN for non-finite inputs rather than a plausible number', () => {
    expect(relativisticStopDistanceKm(Number.NaN, ALPHA_TEN_G_MS2)).toBeNaN();
    expect(relativisticStopDistanceKm(30, Number.NaN)).toBeNaN();
    expect(relativisticStopDistanceKm(Number.POSITIVE_INFINITY, ALPHA_TEN_G_MS2)).toBeNaN();
    expect(relativisticStopCoordSec(Number.NaN, ALPHA_TEN_G_MS2)).toBeNaN();
    expect(relativisticStopCoordSec(30, Number.POSITIVE_INFINITY)).toBeNaN();
  });

  it('stop time is the exact celerity over proper acceleration', () => {
    for (const beta of [1e-4, 0.1, 0.5, 0.9]) {
      const speedKmS = beta * SPEED_OF_LIGHT_KM_S;
      const gamma = 1 / Math.sqrt(1 - beta * beta);
      const expectedSec = (gamma * speedKmS) / (ALPHA_TEN_G_MS2 / 1_000);
      expect(
        relativeError(relativisticStopCoordSec(speedKmS, ALPHA_TEN_G_MS2), expectedSec),
      ).toBeLessThan(1e-12);
    }
  });
});
