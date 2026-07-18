import {
  PREDICTOR_EVENT_BODY_INDEX_OFFSET,
  PREDICTOR_EVENT_CODE_OFFSET,
  PREDICTOR_EVENT_DISTANCE_KM_OFFSET,
  PREDICTOR_EVENT_SECONDARY_BODY_INDEX_OFFSET,
  PREDICTOR_EVENT_STRIDE,
  PREDICTOR_EVENT_TIME_SEC_OFFSET,
  PREDICTOR_POINT_STRIDE,
  PREDICTOR_POINT_TIME_SEC_OFFSET,
  PREDICTOR_POINT_X_KM_OFFSET,
  PREDICTOR_POINT_Y_KM_OFFSET,
  PREDICTOR_POINT_Z_KM_OFFSET,
  PredictorEventCode,
} from '../workers/predictorProtocol.js';

export interface TrajectoryEventSummary {
  readonly closestApproachBodyIndex: number;
  readonly closestApproachTimeSec: number;
  readonly closestApproachDistanceKm: number;
  readonly impactBodyIndex: number;
  readonly impactTimeSec: number;
}

function pointCountOf(packedPoints: Float64Array): number {
  if (packedPoints.length === 0 || packedPoints.length % PREDICTOR_POINT_STRIDE !== 0) {
    throw new RangeError('trajectory points must match the predictor point stride');
  }
  const pointCount = packedPoints.length / PREDICTOR_POINT_STRIDE;
  let previousTimeSec = Number.NEGATIVE_INFINITY;
  for (let pointIndex = 0; pointIndex < pointCount; pointIndex += 1) {
    const offset = pointIndex * PREDICTOR_POINT_STRIDE;
    const timeSec = packedPoints[offset + PREDICTOR_POINT_TIME_SEC_OFFSET] as number;
    const xKm = packedPoints[offset + PREDICTOR_POINT_X_KM_OFFSET] as number;
    const yKm = packedPoints[offset + PREDICTOR_POINT_Y_KM_OFFSET] as number;
    const zKm = packedPoints[offset + PREDICTOR_POINT_Z_KM_OFFSET] as number;
    if (
      !Number.isFinite(timeSec) ||
      !Number.isFinite(xKm) ||
      !Number.isFinite(yKm) ||
      !Number.isFinite(zKm) ||
      timeSec <= previousTimeSec
    ) {
      throw new RangeError('trajectory points must contain finite positions at increasing times');
    }
    previousTimeSec = timeSec;
  }
  return pointCount;
}

function eventCountOf(packedEvents: Float64Array): number {
  if (packedEvents.length % PREDICTOR_EVENT_STRIDE !== 0) {
    throw new RangeError('trajectory events must match the predictor event stride');
  }
  return packedEvents.length / PREDICTOR_EVENT_STRIDE;
}

function writePointPosition(
  outputPositionsKm: Float64Array,
  outputOffset: number,
  packedPoints: Float64Array,
  pointIndex: number,
): void {
  const pointOffset = pointIndex * PREDICTOR_POINT_STRIDE;
  outputPositionsKm[outputOffset] = packedPoints[
    pointOffset + PREDICTOR_POINT_X_KM_OFFSET
  ] as number;
  outputPositionsKm[outputOffset + 1] = packedPoints[
    pointOffset + PREDICTOR_POINT_Y_KM_OFFSET
  ] as number;
  outputPositionsKm[outputOffset + 2] = packedPoints[
    pointOffset + PREDICTOR_POINT_Z_KM_OFFSET
  ] as number;
}

function writePositionAtTimeInto(
  outputPositionsKm: Float64Array,
  outputOffset: number,
  packedPoints: Float64Array,
  pointCount: number,
  timeSec: number,
): boolean {
  const firstTimeSec = packedPoints[PREDICTOR_POINT_TIME_SEC_OFFSET] as number;
  const finalOffset = (pointCount - 1) * PREDICTOR_POINT_STRIDE;
  const finalTimeSec = packedPoints[finalOffset + PREDICTOR_POINT_TIME_SEC_OFFSET] as number;
  if (!Number.isFinite(timeSec) || timeSec < firstTimeSec || timeSec > finalTimeSec) return false;

  let lowerIndex = 0;
  let upperIndex = pointCount - 1;
  while (lowerIndex < upperIndex) {
    const middleIndex = Math.floor((lowerIndex + upperIndex) / 2);
    const middleTimeSec = packedPoints[
      middleIndex * PREDICTOR_POINT_STRIDE + PREDICTOR_POINT_TIME_SEC_OFFSET
    ] as number;
    if (middleTimeSec < timeSec) lowerIndex = middleIndex + 1;
    else upperIndex = middleIndex;
  }

  const upperTimeSec = packedPoints[
    upperIndex * PREDICTOR_POINT_STRIDE + PREDICTOR_POINT_TIME_SEC_OFFSET
  ] as number;
  if (upperTimeSec === timeSec || upperIndex === 0) {
    writePointPosition(outputPositionsKm, outputOffset, packedPoints, upperIndex);
    return true;
  }

  const lowerPointIndex = upperIndex - 1;
  const lowerOffset = lowerPointIndex * PREDICTOR_POINT_STRIDE;
  const upperOffset = upperIndex * PREDICTOR_POINT_STRIDE;
  const lowerTimeSec = packedPoints[lowerOffset + PREDICTOR_POINT_TIME_SEC_OFFSET] as number;
  const fraction = (timeSec - lowerTimeSec) / (upperTimeSec - lowerTimeSec);
  const lowerXKm = packedPoints[lowerOffset + PREDICTOR_POINT_X_KM_OFFSET] as number;
  const lowerYKm = packedPoints[lowerOffset + PREDICTOR_POINT_Y_KM_OFFSET] as number;
  const lowerZKm = packedPoints[lowerOffset + PREDICTOR_POINT_Z_KM_OFFSET] as number;
  outputPositionsKm[outputOffset] =
    lowerXKm +
    fraction * ((packedPoints[upperOffset + PREDICTOR_POINT_X_KM_OFFSET] as number) - lowerXKm);
  outputPositionsKm[outputOffset + 1] =
    lowerYKm +
    fraction * ((packedPoints[upperOffset + PREDICTOR_POINT_Y_KM_OFFSET] as number) - lowerYKm);
  outputPositionsKm[outputOffset + 2] =
    lowerZKm +
    fraction * ((packedPoints[upperOffset + PREDICTOR_POINT_Z_KM_OFFSET] as number) - lowerZKm);
  return true;
}

/** Copies packed predictor xyz positions into stable caller-owned float64 storage. */
export function writePredictionPointsInto(
  outputPositionsKm: Float64Array,
  packedPoints: Float64Array,
): number {
  const pointCount = pointCountOf(packedPoints);
  if (outputPositionsKm.length < pointCount * 3) {
    throw new RangeError('trajectory point output is too small');
  }
  for (let pointIndex = 0; pointIndex < pointCount; pointIndex += 1) {
    writePointPosition(outputPositionsKm, pointIndex * 3, packedPoints, pointIndex);
  }
  return pointCount;
}

/** Writes renderable marker positions and metadata without extrapolating events. */
export function writeTrajectoryMarkersInto(
  outputPositionsKm: Float64Array,
  outputCodes: Float32Array,
  outputBodyIndices: Float32Array,
  packedPoints: Float64Array,
  packedEvents: Float64Array,
): number {
  const pointCount = pointCountOf(packedPoints);
  const eventCount = eventCountOf(packedEvents);
  if (
    outputPositionsKm.length < eventCount * 3 ||
    outputCodes.length < eventCount ||
    outputBodyIndices.length < eventCount
  ) {
    throw new RangeError('trajectory marker output is too small');
  }

  let markerCount = 0;
  for (let eventIndex = 0; eventIndex < eventCount; eventIndex += 1) {
    const eventOffset = eventIndex * PREDICTOR_EVENT_STRIDE;
    const code = packedEvents[eventOffset + PREDICTOR_EVENT_CODE_OFFSET] as number;
    if (
      code !== PredictorEventCode.SoiTransition &&
      code !== PredictorEventCode.ClosestApproach &&
      code !== PredictorEventCode.Impact
    ) {
      continue;
    }
    const timeSec = packedEvents[eventOffset + PREDICTOR_EVENT_TIME_SEC_OFFSET] as number;
    if (
      !writePositionAtTimeInto(
        outputPositionsKm,
        markerCount * 3,
        packedPoints,
        pointCount,
        timeSec,
      )
    ) {
      continue;
    }
    outputCodes[markerCount] = code;
    outputBodyIndices[markerCount] = packedEvents[
      eventOffset +
        (code === PredictorEventCode.SoiTransition
          ? PREDICTOR_EVENT_SECONDARY_BODY_INDEX_OFFSET
          : PREDICTOR_EVENT_BODY_INDEX_OFFSET)
    ] as number;
    markerCount += 1;
  }
  return markerCount;
}

/** Assigns the active dominant body to every rendered trajectory segment. */
export function writeTrajectorySegmentBodiesInto(
  outputBodyIndices: Int32Array,
  packedPoints: Float64Array,
  packedEvents: Float64Array,
  fallbackDominantBodyIndex: number,
): number {
  const pointCount = pointCountOf(packedPoints);
  const eventCount = eventCountOf(packedEvents);
  const segmentCount = Math.max(0, pointCount - 1);
  if (outputBodyIndices.length < segmentCount) {
    throw new RangeError('trajectory segment-body output is too small');
  }

  let activeBodyIndex = fallbackDominantBodyIndex;
  for (let eventIndex = 0; eventIndex < eventCount; eventIndex += 1) {
    const eventOffset = eventIndex * PREDICTOR_EVENT_STRIDE;
    if (
      packedEvents[eventOffset + PREDICTOR_EVENT_CODE_OFFSET] ===
      PredictorEventCode.SoiTransition
    ) {
      activeBodyIndex = packedEvents[
        eventOffset + PREDICTOR_EVENT_BODY_INDEX_OFFSET
      ] as number;
      break;
    }
  }

  let eventIndex = 0;
  for (let segmentIndex = 0; segmentIndex < segmentCount; segmentIndex += 1) {
    const segmentTimeSec = packedPoints[
      segmentIndex * PREDICTOR_POINT_STRIDE + PREDICTOR_POINT_TIME_SEC_OFFSET
    ] as number;
    while (eventIndex < eventCount) {
      const eventOffset = eventIndex * PREDICTOR_EVENT_STRIDE;
      const code = packedEvents[eventOffset + PREDICTOR_EVENT_CODE_OFFSET] as number;
      if (code !== PredictorEventCode.SoiTransition) {
        eventIndex += 1;
        continue;
      }
      const eventTimeSec = packedEvents[eventOffset + PREDICTOR_EVENT_TIME_SEC_OFFSET] as number;
      if (eventTimeSec > segmentTimeSec) break;
      activeBodyIndex = packedEvents[
        eventOffset + PREDICTOR_EVENT_SECONDARY_BODY_INDEX_OFFSET
      ] as number;
      eventIndex += 1;
    }
    outputBodyIndices[segmentIndex] = activeBodyIndex;
  }
  return segmentCount;
}

/** Reads the HUD-relevant event values without assuming global event-time order. */
export function readTrajectoryEventSummary(packedEvents: Float64Array): TrajectoryEventSummary {
  const eventCount = eventCountOf(packedEvents);
  let closestApproachBodyIndex = -1;
  let closestApproachTimeSec = Number.NaN;
  let closestApproachDistanceKm = Number.NaN;
  let impactBodyIndex = -1;
  let impactTimeSec = Number.NaN;
  for (let eventIndex = 0; eventIndex < eventCount; eventIndex += 1) {
    const eventOffset = eventIndex * PREDICTOR_EVENT_STRIDE;
    const code = packedEvents[eventOffset + PREDICTOR_EVENT_CODE_OFFSET] as number;
    if (code === PredictorEventCode.ClosestApproach && closestApproachBodyIndex < 0) {
      closestApproachBodyIndex = packedEvents[
        eventOffset + PREDICTOR_EVENT_BODY_INDEX_OFFSET
      ] as number;
      closestApproachTimeSec = packedEvents[
        eventOffset + PREDICTOR_EVENT_TIME_SEC_OFFSET
      ] as number;
      closestApproachDistanceKm = packedEvents[
        eventOffset + PREDICTOR_EVENT_DISTANCE_KM_OFFSET
      ] as number;
    } else if (code === PredictorEventCode.Impact && impactBodyIndex < 0) {
      impactBodyIndex = packedEvents[eventOffset + PREDICTOR_EVENT_BODY_INDEX_OFFSET] as number;
      impactTimeSec = packedEvents[eventOffset + PREDICTOR_EVENT_TIME_SEC_OFFSET] as number;
    }
  }
  return {
    closestApproachBodyIndex,
    closestApproachTimeSec,
    closestApproachDistanceKm,
    impactBodyIndex,
    impactTimeSec,
  };
}
