import type { AttitudeMode } from '../simulationSnapshot.js';
import { STATE_RX, STATE_RY, STATE_RZ } from './relativity.js';

const QUATERNION_X = 0;
const QUATERNION_Y = 1;
const QUATERNION_Z = 2;
const QUATERNION_W = 3;

function normalizeDirectionOrFallback(
  outputDirection: Float64Array,
  x: number,
  y: number,
  z: number,
  fallbackQuaternion: Float64Array,
): Float64Array {
  const magnitude = Math.hypot(x, y, z);
  if (!Number.isFinite(magnitude) || magnitude === 0) {
    return writeForwardFromQuaternionInto(outputDirection, fallbackQuaternion);
  }
  const inverseMagnitude = 1 / magnitude;
  outputDirection[0] = x * inverseMagnitude;
  outputDirection[1] = y * inverseMagnitude;
  outputDirection[2] = z * inverseMagnitude;
  return outputDirection;
}

/** Writes the inertial direction of the ship-local +X drive axis. */
export function writeForwardFromQuaternionInto(
  outputDirection: Float64Array,
  quaternion: Float64Array,
): Float64Array {
  const x = quaternion[QUATERNION_X] as number;
  const y = quaternion[QUATERNION_Y] as number;
  const z = quaternion[QUATERNION_Z] as number;
  const w = quaternion[QUATERNION_W] as number;
  outputDirection[0] = 1 - 2 * (y * y + z * z);
  outputDirection[1] = 2 * (x * y + z * w);
  outputDirection[2] = 2 * (x * z - y * w);
  return outputDirection;
}

/** Writes the normalized minimum-rotation quaternion from local +X to forward. */
export function writeQuaternionFromForwardInto(
  outputQuaternion: Float64Array,
  forwardX: number,
  forwardY: number,
  forwardZ: number,
): Float64Array {
  const magnitude = Math.hypot(forwardX, forwardY, forwardZ);
  if (!Number.isFinite(magnitude) || magnitude === 0) {
    throw new RangeError('attitude forward direction must be finite and nonzero');
  }
  const x = forwardX / magnitude;
  const y = forwardY / magnitude;
  const z = forwardZ / magnitude;

  if (x <= -1 + 8 * Number.EPSILON) {
    outputQuaternion[QUATERNION_X] = 0;
    outputQuaternion[QUATERNION_Y] = 0;
    outputQuaternion[QUATERNION_Z] = 1;
    outputQuaternion[QUATERNION_W] = 0;
    return outputQuaternion;
  }

  const quaternionY = -z;
  const quaternionZ = y;
  const quaternionW = 1 + x;
  const inverseNorm = 1 / Math.hypot(quaternionY, quaternionZ, quaternionW);
  outputQuaternion[QUATERNION_X] = 0;
  outputQuaternion[QUATERNION_Y] = quaternionY * inverseNorm;
  outputQuaternion[QUATERNION_Z] = quaternionZ * inverseNorm;
  outputQuaternion[QUATERNION_W] = quaternionW * inverseNorm;
  return outputQuaternion;
}

/** Writes q0 multiplied by the exact constant body-rate axis-angle rotation. */
export function evaluateBodyRateQuaternionInto(
  outputQuaternion: Float64Array,
  initialQuaternion: Float64Array,
  angularVelocityBodyRadS: Float64Array,
  elapsedSec: number,
): Float64Array {
  const omegaX = angularVelocityBodyRadS[0] as number;
  const omegaY = angularVelocityBodyRadS[1] as number;
  const omegaZ = angularVelocityBodyRadS[2] as number;
  const omegaMagnitude = Math.hypot(omegaX, omegaY, omegaZ);
  if (omegaMagnitude === 0 || elapsedSec === 0) {
    outputQuaternion.set(initialQuaternion);
    return outputQuaternion;
  }

  const halfAngle = 0.5 * omegaMagnitude * elapsedSec;
  const axisScale = Math.sin(halfAngle) / omegaMagnitude;
  const deltaX = omegaX * axisScale;
  const deltaY = omegaY * axisScale;
  const deltaZ = omegaZ * axisScale;
  const deltaW = Math.cos(halfAngle);
  const initialX = initialQuaternion[QUATERNION_X] as number;
  const initialY = initialQuaternion[QUATERNION_Y] as number;
  const initialZ = initialQuaternion[QUATERNION_Z] as number;
  const initialW = initialQuaternion[QUATERNION_W] as number;

  const x = initialW * deltaX + initialX * deltaW + initialY * deltaZ - initialZ * deltaY;
  const y = initialW * deltaY - initialX * deltaZ + initialY * deltaW + initialZ * deltaX;
  const z = initialW * deltaZ + initialX * deltaY - initialY * deltaX + initialZ * deltaW;
  const w = initialW * deltaW - initialX * deltaX - initialY * deltaY - initialZ * deltaZ;
  const inverseNorm = 1 / Math.hypot(x, y, z, w);
  outputQuaternion[QUATERNION_X] = x * inverseNorm;
  outputQuaternion[QUATERNION_Y] = y * inverseNorm;
  outputQuaternion[QUATERNION_Z] = z * inverseNorm;
  outputQuaternion[QUATERNION_W] = w * inverseNorm;
  return outputQuaternion;
}

/** Returns the body with maximum instantaneous mu/d² at the ship position. */
export function selectMaximumGravityBodyIndex(
  shipState: Float64Array,
  bodyMuKm3S2: Float64Array,
  bodyPositionsKm: Float64Array,
): number {
  const shipXKm = shipState[STATE_RX] as number;
  const shipYKm = shipState[STATE_RY] as number;
  const shipZKm = shipState[STATE_RZ] as number;
  let maximumScore = -1;
  let selectedIndex = -1;
  for (let bodyIndex = 0; bodyIndex < bodyMuKm3S2.length; bodyIndex += 1) {
    const offset = bodyIndex * 3;
    const dxKm = shipXKm - (bodyPositionsKm[offset] as number);
    const dyKm = shipYKm - (bodyPositionsKm[offset + 1] as number);
    const dzKm = shipZKm - (bodyPositionsKm[offset + 2] as number);
    const distanceSquaredKm2 = dxKm * dxKm + dyKm * dyKm + dzKm * dzKm;
    const score = (bodyMuKm3S2[bodyIndex] as number) / distanceSquaredKm2;
    if (score > maximumScore) {
      maximumScore = score;
      selectedIndex = bodyIndex;
    }
  }
  return selectedIndex;
}

/** Writes the requested manual or local-orbital forward direction. */
export function writeAttitudeDirectionInto(
  outputDirection: Float64Array,
  mode: AttitudeMode,
  shipState: Float64Array,
  shipCoordinateVelocityKmS: Float64Array,
  bodyMuKm3S2: Float64Array,
  bodyPositionsKm: Float64Array,
  bodyVelocitiesKmS: Float64Array,
  targetBodyIndex: number,
  fallbackQuaternion: Float64Array,
): Float64Array {
  if (mode === 'manual') {
    return writeForwardFromQuaternionInto(outputDirection, fallbackQuaternion);
  }

  const shipXKm = shipState[STATE_RX] as number;
  const shipYKm = shipState[STATE_RY] as number;
  const shipZKm = shipState[STATE_RZ] as number;
  if (mode === 'target') {
    if (targetBodyIndex < 0 || targetBodyIndex >= bodyMuKm3S2.length) {
      return writeForwardFromQuaternionInto(outputDirection, fallbackQuaternion);
    }
    const targetOffset = targetBodyIndex * 3;
    return normalizeDirectionOrFallback(
      outputDirection,
      (bodyPositionsKm[targetOffset] as number) - shipXKm,
      (bodyPositionsKm[targetOffset + 1] as number) - shipYKm,
      (bodyPositionsKm[targetOffset + 2] as number) - shipZKm,
      fallbackQuaternion,
    );
  }

  const referenceBodyIndex = selectMaximumGravityBodyIndex(shipState, bodyMuKm3S2, bodyPositionsKm);
  if (referenceBodyIndex < 0) {
    return writeForwardFromQuaternionInto(outputDirection, fallbackQuaternion);
  }
  const referenceOffset = referenceBodyIndex * 3;
  const relativeRxKm = shipXKm - (bodyPositionsKm[referenceOffset] as number);
  const relativeRyKm = shipYKm - (bodyPositionsKm[referenceOffset + 1] as number);
  const relativeRzKm = shipZKm - (bodyPositionsKm[referenceOffset + 2] as number);
  const relativeVxKmS =
    (shipCoordinateVelocityKmS[0] as number) - (bodyVelocitiesKmS[referenceOffset] as number);
  const relativeVyKmS =
    (shipCoordinateVelocityKmS[1] as number) - (bodyVelocitiesKmS[referenceOffset + 1] as number);
  const relativeVzKmS =
    (shipCoordinateVelocityKmS[2] as number) - (bodyVelocitiesKmS[referenceOffset + 2] as number);

  let directionX = relativeVxKmS;
  let directionY = relativeVyKmS;
  let directionZ = relativeVzKmS;
  if (mode === 'radialOut' || mode === 'radialIn') {
    directionX = relativeRxKm;
    directionY = relativeRyKm;
    directionZ = relativeRzKm;
  } else if (mode === 'normal' || mode === 'antinormal') {
    directionX = relativeRyKm * relativeVzKmS - relativeRzKm * relativeVyKmS;
    directionY = relativeRzKm * relativeVxKmS - relativeRxKm * relativeVzKmS;
    directionZ = relativeRxKm * relativeVyKmS - relativeRyKm * relativeVxKmS;
  }

  if (mode === 'retrograde' || mode === 'radialIn' || mode === 'antinormal') {
    directionX = -directionX;
    directionY = -directionY;
    directionZ = -directionZ;
  }
  return normalizeDirectionOrFallback(
    outputDirection,
    directionX,
    directionY,
    directionZ,
    fallbackQuaternion,
  );
}
