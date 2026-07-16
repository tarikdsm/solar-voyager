// physics-spec.md §3 / §6 — special-relativistic ship kinematics.

import { SPEED_OF_LIGHT_KM_S } from '../../core/constants.js';
import type { Dp54Derivative } from '../propagation/dp54.js';

export const RELATIVISTIC_STATE_DIMENSION = 7;
export const STATE_RX = 0;
export const STATE_RY = 1;
export const STATE_RZ = 2;
export const STATE_UX = 3;
export const STATE_UY = 4;
export const STATE_UZ = 5;
export const STATE_TAU = 6;

// Direction normalization and Math.hypot can each consume a few ulps.
const MAX_SUBLUMINAL_BETA = 1 - 8 * Number.EPSILON;

/** Writes a gravity or proper-acceleration vector in km/s^2. */
export type RelativisticAccelerationEvaluator = (
  timeSec: number,
  state: Float64Array,
  outputAcceleration: Float64Array,
) => void;

function dimensionlessCelerityMagnitude(ux: number, uy: number, uz: number): number {
  return Math.hypot(ux / SPEED_OF_LIGHT_KM_S, uy / SPEED_OF_LIGHT_KM_S, uz / SPEED_OF_LIGHT_KM_S);
}

function subluminalBetaFromCelerity(ux: number, uy: number, uz: number): number {
  const dimensionlessCelerity = dimensionlessCelerityMagnitude(ux, uy, uz);
  return Math.min(
    dimensionlessCelerity / Math.hypot(1, dimensionlessCelerity),
    MAX_SUBLUMINAL_BETA,
  );
}

function writeCoordinateVelocity(
  output: Float64Array,
  outputX: number,
  outputY: number,
  outputZ: number,
  ux: number,
  uy: number,
  uz: number,
): number {
  const dimensionlessUx = ux / SPEED_OF_LIGHT_KM_S;
  const dimensionlessUy = uy / SPEED_OF_LIGHT_KM_S;
  const dimensionlessUz = uz / SPEED_OF_LIGHT_KM_S;
  const dimensionlessCelerity = Math.hypot(dimensionlessUx, dimensionlessUy, dimensionlessUz);
  if (dimensionlessCelerity === 0) {
    output[outputX] = ux;
    output[outputY] = uy;
    output[outputZ] = uz;
    return 1;
  }

  const gamma = Math.hypot(1, dimensionlessCelerity);
  const beta = Math.min(dimensionlessCelerity / gamma, MAX_SUBLUMINAL_BETA);
  const coordinateSpeedKmSec = beta * SPEED_OF_LIGHT_KM_S;
  output[outputX] = (dimensionlessUx / dimensionlessCelerity) * coordinateSpeedKmSec;
  output[outputY] = (dimensionlessUy / dimensionlessCelerity) * coordinateSpeedKmSec;
  output[outputZ] = (dimensionlessUz / dimensionlessCelerity) * coordinateSpeedKmSec;
  return 1 / gamma;
}

/** Returns gamma = sqrt(1 + |u|^2/c^2) for celerity components in km/s. */
export function lorentzFactorFromCelerity(ux: number, uy: number, uz: number): number {
  return Math.hypot(1, dimensionlessCelerityMagnitude(ux, uy, uz));
}

/** Writes coordinate velocity v = u/gamma in km/s without allocating. */
export function coordinateVelocityInto(
  output: Float64Array,
  ux: number,
  uy: number,
  uz: number,
): Float64Array {
  writeCoordinateVelocity(output, 0, 1, 2, ux, uy, uz);
  return output;
}

/** Returns |v|/c from celerity without constructing a velocity vector. */
export function speedFractionOfLightFromCelerity(ux: number, uy: number, uz: number): number {
  return subluminalBetaFromCelerity(ux, uy, uz);
}

/** Writes p = m*u in kg km/s without allocating. */
export function relativisticMomentumInto(
  output: Float64Array,
  ux: number,
  uy: number,
  uz: number,
  massKg: number,
): Float64Array {
  output[0] = massKg * ux;
  output[1] = massKg * uy;
  output[2] = massKg * uz;
  return output;
}

/** Returns (gamma - 1)mc^2 in joules, retaining precision in the Newtonian limit. */
export function relativisticKineticEnergyJ(
  ux: number,
  uy: number,
  uz: number,
  massKg: number,
): number {
  const dimensionlessCelerity = dimensionlessCelerityMagnitude(ux, uy, uz);
  const gamma = Math.hypot(1, dimensionlessCelerity);
  const gammaMinusOne = dimensionlessCelerity * (dimensionlessCelerity / (gamma + 1));
  const lightSpeedMetersSec = SPEED_OF_LIGHT_KM_S * 1_000;
  return gammaMinusOne * massKg * lightSpeedMetersSec * lightSpeedMetersSec;
}

/**
 * Creates the allocation-free (r, u, tau) derivative from physics-spec.md §3.
 * Callback output buffers are allocated once here and reused for every stage.
 */
export function createRelativisticDerivative(
  gravity: RelativisticAccelerationEvaluator,
  properAcceleration: RelativisticAccelerationEvaluator,
): Dp54Derivative {
  const gravityOutput = new Float64Array(3);
  const properAccelerationOutput = new Float64Array(3);

  return (timeSec, state, outputDerivative): void => {
    const ux = state[STATE_UX] as number;
    const uy = state[STATE_UY] as number;
    const uz = state[STATE_UZ] as number;

    gravity(timeSec, state, gravityOutput);
    properAcceleration(timeSec, state, properAccelerationOutput);

    const inverseGamma = writeCoordinateVelocity(
      outputDerivative,
      STATE_RX,
      STATE_RY,
      STATE_RZ,
      ux,
      uy,
      uz,
    );
    outputDerivative[STATE_UX] =
      (gravityOutput[0] as number) + (properAccelerationOutput[0] as number);
    outputDerivative[STATE_UY] =
      (gravityOutput[1] as number) + (properAccelerationOutput[1] as number);
    outputDerivative[STATE_UZ] =
      (gravityOutput[2] as number) + (properAccelerationOutput[2] as number);
    outputDerivative[STATE_TAU] = inverseGamma;
  };
}
