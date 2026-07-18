import {
  PREDICTOR_EVENT_BODY_INDEX_OFFSET,
  PREDICTOR_EVENT_CODE_OFFSET,
  PREDICTOR_EVENT_DISTANCE_KM_OFFSET,
  PREDICTOR_EVENT_SECONDARY_BODY_INDEX_OFFSET,
  PREDICTOR_EVENT_STRIDE,
  PREDICTOR_EVENT_TIME_SEC_OFFSET,
  PREDICTOR_EVENT_TIME_TO_IMPACT_SEC_OFFSET,
  PREDICTOR_MAX_POINTS,
  PREDICTOR_POINT_STRIDE,
  PREDICTOR_POINT_TIME_SEC_OFFSET,
  PREDICTOR_POINT_X_KM_OFFSET,
  PREDICTOR_POINT_Y_KM_OFFSET,
  PREDICTOR_POINT_Z_KM_OFFSET,
  PREDICTOR_STATE_LENGTH,
  PredictorEventCode,
} from '../../workers/predictorProtocol.js';
import {
  createDp54Result,
  createDp54Workspace,
  createShipDp54Tolerance,
  propagate,
} from '../propagation/dp54.js';
import { evaluateNBodyAccelerationInto } from '../propagation/nbodyForces.js';
import {
  createRailsState,
  createRailsWorkspace,
  evaluateRailsInto,
  type CompiledRailsCatalog,
} from '../propagation/rails.js';
import { createRelativisticDerivative, STATE_RX, STATE_RY, STATE_RZ } from '../ship/relativity.js';
import { selectDominantBodyIndexWithHysteresis } from './dominantBody.js';

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

export interface ThrustFreeTrajectory {
  readonly points: Float64Array<ArrayBuffer>;
  readonly events: Float64Array<ArrayBuffer>;
}

interface ValidatedPrediction {
  readonly pointCount: number;
  readonly endTimeSec: number;
  readonly targetBodyIndex: number;
}

function isBodyIndex(value: number, bodyCount: number): boolean {
  return Number.isInteger(value) && value >= -1 && value < bodyCount;
}

function validateOptions(options: ThrustFreeTrajectoryOptions): ValidatedPrediction {
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

function distanceToBodyKm(
  shipState: Float64Array,
  bodyPositionsKm: Float64Array,
  bodyIndex: number,
): number {
  const bodyOffset = bodyIndex * 3;
  return Math.hypot(
    (shipState[STATE_RX] as number) - (bodyPositionsKm[bodyOffset] as number),
    (shipState[STATE_RY] as number) - (bodyPositionsKm[bodyOffset + 1] as number),
    (shipState[STATE_RZ] as number) - (bodyPositionsKm[bodyOffset + 2] as number),
  );
}

function writePoint(
  points: Float64Array,
  pointIndex: number,
  timeSec: number,
  state: Float64Array,
): void {
  const offset = pointIndex * PREDICTOR_POINT_STRIDE;
  points[offset + PREDICTOR_POINT_TIME_SEC_OFFSET] = timeSec;
  points[offset + PREDICTOR_POINT_X_KM_OFFSET] = state[STATE_RX] as number;
  points[offset + PREDICTOR_POINT_Y_KM_OFFSET] = state[STATE_RY] as number;
  points[offset + PREDICTOR_POINT_Z_KM_OFFSET] = state[STATE_RZ] as number;
}

function writeEvent(
  events: Float64Array,
  eventIndex: number,
  code: number,
  timeSec: number,
  bodyIndex: number,
  secondaryBodyIndex: number,
  distanceKm: number,
  timeToImpactSec: number,
): void {
  const offset = eventIndex * PREDICTOR_EVENT_STRIDE;
  events[offset + PREDICTOR_EVENT_CODE_OFFSET] = code;
  events[offset + PREDICTOR_EVENT_TIME_SEC_OFFSET] = timeSec;
  events[offset + PREDICTOR_EVENT_BODY_INDEX_OFFSET] = bodyIndex;
  events[offset + PREDICTOR_EVENT_SECONDARY_BODY_INDEX_OFFSET] = secondaryBodyIndex;
  events[offset + PREDICTOR_EVENT_DISTANCE_KM_OFFSET] = distanceKm;
  events[offset + PREDICTOR_EVENT_TIME_TO_IMPACT_SEC_OFFSET] = timeToImpactSec;
}

/**
 * Produces a packed, thrust-free prediction with physics-spec.md section 6 sampling.
 * The canonical section 2/3 rails, n-body field, relativistic derivative, and DP54 are reused.
 */
export function predictThrustFreeTrajectory(
  options: ThrustFreeTrajectoryOptions,
): ThrustFreeTrajectory {
  const validated = validateOptions(options);
  const { catalog, collisionRadiiKm, startTimeSec } = options;
  const railsState = createRailsState(catalog);
  const railsWorkspace = createRailsWorkspace();
  const derivative = createRelativisticDerivative(
    (timeSec, state, outputAcceleration) => {
      evaluateRailsInto(railsState, catalog, timeSec, railsWorkspace);
      evaluateNBodyAccelerationInto(
        outputAcceleration,
        state,
        catalog.muKm3S2,
        railsState.positionsKm,
      );
    },
    (_timeSec, _state, outputAcceleration) => {
      outputAcceleration[0] = 0;
      outputAcceleration[1] = 0;
      outputAcceleration[2] = 0;
    },
  );
  const tolerance = createShipDp54Tolerance();
  const workspace = createDp54Workspace(PREDICTOR_STATE_LENGTH);
  const propagationResult = createDp54Result();
  const state = new Float64Array(options.shipState);
  const previousDistancesKm = new Float64Array(catalog.bodyCount);
  const points = new Float64Array(validated.pointCount * PREDICTOR_POINT_STRIDE);
  const events = new Float64Array((validated.pointCount + 2) * PREDICTOR_EVENT_STRIDE);
  const sampleIntervalSec = options.horizonSec / (validated.pointCount - 1);
  let previousTimeSec = startTimeSec;
  let writtenPointCount = 1;
  let eventCount = 0;
  let dominantBodyIndex = options.dominantBodyIndex;
  let closestTimeSec = startTimeSec;
  let closestDistanceKm = Number.POSITIVE_INFINITY;

  evaluateRailsInto(railsState, catalog, startTimeSec, railsWorkspace);
  writePoint(points, 0, startTimeSec, state);
  for (let bodyIndex = 0; bodyIndex < catalog.bodyCount; bodyIndex += 1) {
    previousDistancesKm[bodyIndex] = distanceToBodyKm(state, railsState.positionsKm, bodyIndex);
  }
  if (validated.targetBodyIndex >= 0) {
    closestDistanceKm = previousDistancesKm[validated.targetBodyIndex] as number;
  }

  const initialDominantBodyIndex = selectDominantBodyIndexWithHysteresis(
    state,
    railsState.positionsKm,
    catalog,
    dominantBodyIndex,
  );
  if (initialDominantBodyIndex !== dominantBodyIndex) {
    writeEvent(
      events,
      eventCount,
      PredictorEventCode.SoiTransition,
      startTimeSec,
      dominantBodyIndex,
      initialDominantBodyIndex,
      Number.NaN,
      Number.NaN,
    );
    eventCount += 1;
    dominantBodyIndex = initialDominantBodyIndex;
  }

  for (let sampleIndex = 1; sampleIndex < validated.pointCount; sampleIndex += 1) {
    const sampleTimeSec =
      sampleIndex === validated.pointCount - 1
        ? validated.endTimeSec
        : startTimeSec + sampleIndex * sampleIntervalSec;
    const previousXKm = state[STATE_RX] as number;
    const previousYKm = state[STATE_RY] as number;
    const previousZKm = state[STATE_RZ] as number;
    propagate(
      state,
      state,
      previousTimeSec,
      sampleTimeSec,
      derivative,
      tolerance,
      workspace,
      propagationResult,
    );
    if (!propagationResult.reachedEnd) {
      throw new Error(
        `trajectory propagation failed at ${sampleTimeSec}: budgetExhausted=${propagationResult.budgetExhausted}, stepUnderflow=${propagationResult.stepUnderflow}, nonFiniteError=${propagationResult.nonFiniteError}`,
      );
    }
    if (propagationResult.nextStepSec !== 0) {
      tolerance.initialStepSec = propagationResult.nextStepSec;
    }
    evaluateRailsInto(railsState, catalog, sampleTimeSec, railsWorkspace);

    let impactBodyIndex = -1;
    let impactFraction = Number.POSITIVE_INFINITY;
    for (let bodyIndex = 0; bodyIndex < catalog.bodyCount; bodyIndex += 1) {
      const currentDistanceKm = distanceToBodyKm(state, railsState.positionsKm, bodyIndex);
      const radiusKm = collisionRadiiKm[bodyIndex] as number;
      const previousClearanceKm = (previousDistancesKm[bodyIndex] as number) - radiusKm;
      const currentClearanceKm = currentDistanceKm - radiusKm;
      if (previousClearanceKm > 0 && currentClearanceKm <= 0) {
        const crossingFraction = previousClearanceKm / (previousClearanceKm - currentClearanceKm);
        if (crossingFraction < impactFraction) {
          impactFraction = crossingFraction;
          impactBodyIndex = bodyIndex;
        }
      }
      previousDistancesKm[bodyIndex] = currentDistanceKm;
    }

    let outputTimeSec = sampleTimeSec;
    if (impactBodyIndex >= 0) {
      outputTimeSec = previousTimeSec + impactFraction * (sampleTimeSec - previousTimeSec);
      state[STATE_RX] = previousXKm + impactFraction * ((state[STATE_RX] as number) - previousXKm);
      state[STATE_RY] = previousYKm + impactFraction * ((state[STATE_RY] as number) - previousYKm);
      state[STATE_RZ] = previousZKm + impactFraction * ((state[STATE_RZ] as number) - previousZKm);
      evaluateRailsInto(railsState, catalog, outputTimeSec, railsWorkspace);
    }

    writePoint(points, writtenPointCount, outputTimeSec, state);
    writtenPointCount += 1;
    const selectedDominantBodyIndex = selectDominantBodyIndexWithHysteresis(
      state,
      railsState.positionsKm,
      catalog,
      dominantBodyIndex,
    );
    if (selectedDominantBodyIndex !== dominantBodyIndex) {
      writeEvent(
        events,
        eventCount,
        PredictorEventCode.SoiTransition,
        outputTimeSec,
        dominantBodyIndex,
        selectedDominantBodyIndex,
        Number.NaN,
        Number.NaN,
      );
      eventCount += 1;
      dominantBodyIndex = selectedDominantBodyIndex;
    }
    if (validated.targetBodyIndex >= 0) {
      const targetDistanceKm = distanceToBodyKm(
        state,
        railsState.positionsKm,
        validated.targetBodyIndex,
      );
      if (targetDistanceKm < closestDistanceKm) {
        closestDistanceKm = targetDistanceKm;
        closestTimeSec = outputTimeSec;
      }
    }
    if (impactBodyIndex >= 0) {
      writeEvent(
        events,
        eventCount,
        PredictorEventCode.Impact,
        outputTimeSec,
        impactBodyIndex,
        -1,
        collisionRadiiKm[impactBodyIndex] as number,
        outputTimeSec - startTimeSec,
      );
      eventCount += 1;
      break;
    }

    previousTimeSec = sampleTimeSec;
  }

  if (validated.targetBodyIndex >= 0) {
    writeEvent(
      events,
      eventCount,
      PredictorEventCode.ClosestApproach,
      closestTimeSec,
      validated.targetBodyIndex,
      -1,
      closestDistanceKm,
      Number.NaN,
    );
    eventCount += 1;
  }

  return {
    points: points.slice(0, writtenPointCount * PREDICTOR_POINT_STRIDE),
    events: events.slice(0, eventCount * PREDICTOR_EVENT_STRIDE),
  };
}
