// physics-spec.md section 8.3 — exact relativistic braking envelope (ADR-037).

import { SPEED_OF_LIGHT_KM_S } from '../../core/constants.js';

/** Converts a proper acceleration in m/s^2 to the simulation's km/s^2, or NaN. */
function properAccelerationKmS2(alphaMS2: number): number {
  return Number.isFinite(alphaMS2) ? alphaMS2 / 1_000 : Number.NaN;
}

/**
 * Returns `gamma - 1` for `|beta|`, without cancellation at either end of the
 * range: the `(1-beta)(1+beta)` factorisation keeps precision as `beta` approaches
 * one, and dividing by `1 + 1/gamma` keeps it as `beta` approaches zero, where the
 * naive difference of two near-equal numbers would lose every significant digit.
 */
function lorentzFactorExcess(beta: number): number {
  const inverseGamma = Math.sqrt((1 - beta) * (1 + beta));
  return (beta * beta) / (inverseGamma * (1 + inverseGamma));
}

/**
 * Coordinate distance needed to brake from `relSpeedKmS` to relative rest at a
 * constant proper acceleration: `(c^2/alpha)(gamma_rel - 1)` (physics-spec §8.3).
 *
 * Used by the approach-brake assist and the cruise brake phase. The argument is a
 * magnitude, so its sign is irrelevant. A ship that cannot brake (`alpha <= 0`) or
 * that is not subluminal has an unbounded envelope, reported as `+Infinity` rather
 * than NaN so that a `distance < k * stopDistance` guard fails toward warning.
 * Non-finite inputs return NaN.
 */
export function relativisticStopDistanceKm(relSpeedKmS: number, alphaMS2: number): number {
  const alphaKmS2 = properAccelerationKmS2(alphaMS2);
  if (Number.isNaN(alphaKmS2) || !Number.isFinite(relSpeedKmS)) return Number.NaN;
  if (alphaKmS2 <= 0) return Number.POSITIVE_INFINITY;

  const beta = Math.abs(relSpeedKmS) / SPEED_OF_LIGHT_KM_S;
  if (beta === 0) return 0;
  if (beta >= 1) return Number.POSITIVE_INFINITY;
  return ((SPEED_OF_LIGHT_KM_S * SPEED_OF_LIGHT_KM_S) / alphaKmS2) * lorentzFactorExcess(beta);
}

/**
 * Coordinate time needed for the same stop: `u_rel / alpha` (physics-spec §8.3).
 * Exact because celerity is linear in coordinate time under constant proper
 * acceleration, which is the whole reason the section closes in elementary form.
 */
export function relativisticStopCoordSec(relSpeedKmS: number, alphaMS2: number): number {
  const alphaKmS2 = properAccelerationKmS2(alphaMS2);
  if (Number.isNaN(alphaKmS2) || !Number.isFinite(relSpeedKmS)) return Number.NaN;
  if (alphaKmS2 <= 0) return Number.POSITIVE_INFINITY;

  const speedKmS = Math.abs(relSpeedKmS);
  if (speedKmS === 0) return 0;
  const beta = speedKmS / SPEED_OF_LIGHT_KM_S;
  if (beta >= 1) return Number.POSITIVE_INFINITY;
  return speedKmS / (Math.sqrt((1 - beta) * (1 + beta)) * alphaKmS2);
}
