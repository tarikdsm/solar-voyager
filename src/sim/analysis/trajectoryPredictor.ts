import {
  PREDICTOR_EVENT_BODY_INDEX_OFFSET,
  PREDICTOR_EVENT_CODE_OFFSET,
  PREDICTOR_EVENT_DISTANCE_KM_OFFSET,
  PREDICTOR_EVENT_SECONDARY_BODY_INDEX_OFFSET,
  PREDICTOR_EVENT_STRIDE,
  PREDICTOR_EVENT_TIME_SEC_OFFSET,
  PREDICTOR_EVENT_TIME_TO_IMPACT_SEC_OFFSET,
  PREDICTOR_POINT_STRIDE,
  PREDICTOR_POINT_TIME_SEC_OFFSET,
  PREDICTOR_POINT_X_KM_OFFSET,
  PREDICTOR_POINT_Y_KM_OFFSET,
  PREDICTOR_POINT_Z_KM_OFFSET,
  PREDICTOR_STATE_LENGTH,
  PredictorEventCode,
} from './trajectoryPredictionLayout.js';
import {
  createDp54Result,
  createDp54Workspace,
  createShipDp54Tolerance,
  propagate,
} from '../propagation/dp54.js';
import { evaluateNBodyAccelerationInto } from '../propagation/nbodyForces.js';
import { createRailsState, createRailsWorkspace, evaluateRailsInto } from '../propagation/rails.js';
import { createRelativisticDerivative, STATE_RX, STATE_RY, STATE_RZ } from '../ship/relativity.js';
import { selectDominantBodyIndexWithHysteresis } from './dominantBody.js';
import {
  captureTrajectoryImpactStepStart,
  createTrajectoryImpactWorkspace,
  findFirstTrajectoryImpactInto,
  interpolateTrajectoryImpactPositionInto,
  trajectoryDistanceToBodyKm,
} from './trajectoryImpact.js';
import {
  type ThrustFreeTrajectoryOptions,
  validateTrajectoryPredictionOptions,
} from './trajectoryPredictorSetup.js';

export type { ThrustFreeTrajectoryOptions } from './trajectoryPredictorSetup.js';

export interface ThrustFreeTrajectory {
  readonly points: Float64Array<ArrayBuffer>;
  readonly events: Float64Array<ArrayBuffer>;
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
  const validated = validateTrajectoryPredictionOptions(options);
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
  const maxAcceptedStepsPerOutput = tolerance.maxAcceptedSteps;
  tolerance.maxAcceptedSteps = 1;
  const workspace = createDp54Workspace(PREDICTOR_STATE_LENGTH);
  const propagationResult = createDp54Result();
  const impactWorkspace = createTrajectoryImpactWorkspace(catalog.bodyCount);
  const state = new Float64Array(options.shipState);
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
  if (validated.targetBodyIndex >= 0) {
    closestDistanceKm = trajectoryDistanceToBodyKm(
      state,
      railsState.positionsKm,
      validated.targetBodyIndex,
    );
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
    let acceptedSteps = 0;
    let integrationTimeSec = previousTimeSec;
    let outputTimeSec = sampleTimeSec;
    let impactBodyIndex = -1;

    while (integrationTimeSec !== sampleTimeSec) {
      if (acceptedSteps >= maxAcceptedStepsPerOutput) {
        throw new Error(`trajectory propagation exhausted step budget at ${sampleTimeSec}`);
      }
      const stepStartXKm = state[STATE_RX] as number;
      const stepStartYKm = state[STATE_RY] as number;
      const stepStartZKm = state[STATE_RZ] as number;
      evaluateRailsInto(railsState, catalog, integrationTimeSec, railsWorkspace);
      captureTrajectoryImpactStepStart(impactWorkspace, railsState.positionsKm);
      propagate(
        state,
        state,
        integrationTimeSec,
        sampleTimeSec,
        derivative,
        tolerance,
        workspace,
        propagationResult,
      );
      if (propagationResult.acceptedSteps !== 1) {
        throw new Error(
          `trajectory propagation failed at ${sampleTimeSec}: stepUnderflow=${propagationResult.stepUnderflow}, nonFiniteError=${propagationResult.nonFiniteError}`,
        );
      }
      acceptedSteps += 1;
      if (propagationResult.nextStepSec !== 0) {
        tolerance.initialStepSec = propagationResult.nextStepSec;
      }
      const stepEndTimeSec = propagationResult.reachedTimeSec;
      evaluateRailsInto(railsState, catalog, stepEndTimeSec, railsWorkspace);
      const impact = findFirstTrajectoryImpactInto(
        impactWorkspace,
        stepStartXKm,
        stepStartYKm,
        stepStartZKm,
        state,
        railsState.positionsKm,
        collisionRadiiKm,
      );
      if (impact.bodyIndex >= 0) {
        outputTimeSec =
          integrationTimeSec + impact.fraction * (stepEndTimeSec - integrationTimeSec);
        interpolateTrajectoryImpactPositionInto(
          state,
          stepStartXKm,
          stepStartYKm,
          stepStartZKm,
          impact.fraction,
        );
        impactBodyIndex = impact.bodyIndex;
        evaluateRailsInto(railsState, catalog, outputTimeSec, railsWorkspace);
        break;
      }
      integrationTimeSec = stepEndTimeSec;
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
      const targetDistanceKm = trajectoryDistanceToBodyKm(
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
