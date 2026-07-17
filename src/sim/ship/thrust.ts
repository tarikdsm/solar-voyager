import { SPEED_OF_LIGHT_KM_S } from '../../core/constants.js';

/** Canonical 1 g default from ADR-025, in meters per second squared. */
export const DEFAULT_MAX_PROPER_ACCELERATION_M_S2 = 9.80665;

/** Validates setup configuration and returns maximum proper acceleration in km/s². */
export function validateMaxProperAcceleration(maximumAccelerationMS2: number): number {
  if (!Number.isFinite(maximumAccelerationMS2) || maximumAccelerationMS2 <= 0) {
    throw new RangeError('maximum proper acceleration must be finite and positive');
  }
  return maximumAccelerationMS2 / 1_000;
}

/** Writes alpha = throttle*alphaMax*forward in km/s² without allocating. */
export function writeProperAccelerationInto(
  outputAccelerationKmS2: Float64Array,
  forwardDirection: Float64Array,
  throttle: number,
  maximumAccelerationKmS2: number,
): Float64Array {
  const magnitudeKmS2 = throttle * maximumAccelerationKmS2;
  outputAccelerationKmS2[0] = (forwardDirection[0] as number) * magnitudeKmS2;
  outputAccelerationKmS2[1] = (forwardDirection[1] as number) * magnitudeKmS2;
  outputAccelerationKmS2[2] = (forwardDirection[2] as number) * magnitudeKmS2;
  return outputAccelerationKmS2;
}

/** Writes F = m*alpha in newtons for alpha supplied in km/s². */
export function writeThrustForceInto(
  outputForceN: Float64Array,
  properAccelerationKmS2: Float64Array,
  shipMassKg: number,
): Float64Array {
  const forceScale = shipMassKg * 1_000;
  outputForceN[0] = (properAccelerationKmS2[0] as number) * forceScale;
  outputForceN[1] = (properAccelerationKmS2[1] as number) * forceScale;
  outputForceN[2] = (properAccelerationKmS2[2] as number) * forceScale;
  return outputForceN;
}

/** Returns photon-drive P = |F|c in watts. */
export function photonDrivePowerW(
  properAccelerationKmS2: Float64Array,
  shipMassKg: number,
): number {
  const accelerationMS2 =
    Math.hypot(
      properAccelerationKmS2[0] as number,
      properAccelerationKmS2[1] as number,
      properAccelerationKmS2[2] as number,
    ) * 1_000;
  return shipMassKg * accelerationMS2 * SPEED_OF_LIGHT_KM_S * 1_000;
}
