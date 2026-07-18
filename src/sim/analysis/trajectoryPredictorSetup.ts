import type { CompiledRailsCatalog } from '../propagation/rails.js';
import { PREDICTOR_MAX_POINTS, PREDICTOR_STATE_LENGTH } from './trajectoryPredictionLayout.js';

export interface ThrustFreeTrajectoryOptions {
  readonly catalog: CompiledRailsCatalog;
  readonly collisionRadiiKm: Float64Array;
  readonly startTimeSec: number;
  readonly horizonSec: number;
  readonly shipState: Float64Array;
  readonly dominantBodyIndex: number;
  readonly targetBodyIndex?: number;
  readonly outputPointCount?: number;
}

export interface ValidatedTrajectoryPrediction {
  readonly pointCount: number;
  readonly endTimeSec: number;
  readonly targetBodyIndex: number;
}

function isBodyIndex(value: number, bodyCount: number): boolean {
  return Number.isInteger(value) && value >= -1 && value < bodyCount;
}

/** Validates setup-sized storage and scalar bounds before allocating predictor workspaces. */
export function validateTrajectoryPredictionOptions(
  options: ThrustFreeTrajectoryOptions,
): ValidatedTrajectoryPrediction {
  const { catalog, collisionRadiiKm, shipState } = options;
  if (!(collisionRadiiKm instanceof Float64Array)) {
    throw new TypeError('collision radii must use float64 storage');
  }
  if (collisionRadiiKm.length !== catalog.bodyCount) {
    throw new RangeError(`collision radii must contain ${catalog.bodyCount} values`);
  }
  for (let bodyIndex = 0; bodyIndex < collisionRadiiKm.length; bodyIndex += 1) {
    const radiusKm = collisionRadiiKm[bodyIndex] as number;
    if (!Number.isFinite(radiusKm) || radiusKm < 0) {
      throw new RangeError('collision radii must be finite and non-negative');
    }
  }
  if (!(shipState instanceof Float64Array) || shipState.length !== PREDICTOR_STATE_LENGTH) {
    throw new RangeError(`ship state must contain ${PREDICTOR_STATE_LENGTH} float64 values`);
  }
  for (let index = 0; index < shipState.length; index += 1) {
    if (!Number.isFinite(shipState[index])) throw new RangeError('ship state must be finite');
  }
  if (!Number.isFinite(options.startTimeSec)) {
    throw new RangeError('prediction start time must be finite');
  }
  if (!Number.isFinite(options.horizonSec) || options.horizonSec <= 0) {
    throw new RangeError('prediction horizon must be positive and finite');
  }
  const endTimeSec = options.startTimeSec + options.horizonSec;
  if (!Number.isFinite(endTimeSec)) throw new RangeError('prediction endpoint must be finite');
  if (!isBodyIndex(options.dominantBodyIndex, catalog.bodyCount)) {
    throw new RangeError('dominant body index is outside the catalog');
  }
  const targetBodyIndex = options.targetBodyIndex ?? -1;
  if (!isBodyIndex(targetBodyIndex, catalog.bodyCount)) {
    throw new RangeError('target body index is outside the catalog');
  }
  const requestedPointCount = options.outputPointCount ?? PREDICTOR_MAX_POINTS;
  if (!Number.isInteger(requestedPointCount) || requestedPointCount < 2) {
    throw new RangeError('prediction output must request at least two points');
  }
  return {
    pointCount: Math.min(requestedPointCount, PREDICTOR_MAX_POINTS),
    endTimeSec,
    targetBodyIndex,
  };
}
