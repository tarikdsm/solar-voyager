import {
  PREDICTOR_BASE_HORIZON_SEC,
  PREDICTOR_EVENT_BODY_INDEX_OFFSET,
  PREDICTOR_EVENT_CODE_OFFSET,
  PREDICTOR_EVENT_DISTANCE_KM_OFFSET,
  PREDICTOR_EVENT_SECONDARY_BODY_INDEX_OFFSET,
  PREDICTOR_EVENT_STRIDE,
  PREDICTOR_EVENT_TIME_SEC_OFFSET,
  PREDICTOR_EVENT_TIME_TO_IMPACT_SEC_OFFSET,
  PREDICTOR_MAX_POINTS,
  PREDICTOR_POINT_STRIDE,
  PREDICTOR_STATE_LENGTH,
  PredictorEventCode,
  type PredictorEventCode as PredictorEventCodeValue,
} from '../sim/analysis/trajectoryPredictionLayout.js';

export {
  PREDICTOR_BASE_HORIZON_SEC,
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
} from '../sim/analysis/trajectoryPredictionLayout.js';

/** Stateless trajectory job sent to the prediction worker. */
export interface PredictorRequestMessage {
  readonly type: 'predict';
  readonly requestId: number;
  readonly startTimeSec: number;
  readonly shipState: Float64Array<ArrayBuffer>;
  readonly osculatingPeriodSec: number;
  readonly userHorizonSec?: number;
  readonly dominantBodyIndex: number;
  readonly targetBodyIndex?: number;
}

/** Packed points and events returned for a completed trajectory job. */
export interface PredictorSuccessMessage {
  readonly type: 'success';
  readonly requestId: number;
  readonly points: Float64Array<ArrayBuffer>;
  readonly events: Float64Array<ArrayBuffer>;
}

/** Deterministic failure returned without transferred buffers. */
export interface PredictorErrorMessage {
  readonly type: 'error';
  readonly requestId: number;
  readonly message: string;
}

export type PredictorResponseMessage = PredictorSuccessMessage | PredictorErrorMessage;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): boolean {
  const keys = Object.keys(value);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (key !== undefined && !allowedKeys.includes(key)) return false;
  }
  return true;
}

function isRequestId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isBodyIndex(value: unknown, bodyCount: number): value is number {
  return Number.isInteger(value) && (value as number) >= -1 && (value as number) < bodyCount;
}

function isCatalogBodyIndex(value: unknown, bodyCount: number): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) < bodyCount;
}

function isValidBodyCount(bodyCount: number): boolean {
  return Number.isInteger(bodyCount) && bodyCount >= 0;
}

function isOwnedFloat64Array(value: unknown): value is Float64Array<ArrayBuffer> {
  return (
    value instanceof Float64Array &&
    value.buffer instanceof ArrayBuffer &&
    value.byteOffset === 0 &&
    value.byteLength === value.buffer.byteLength
  );
}

function hasFiniteComponents(values: Float64Array): boolean {
  for (let index = 0; index < values.length; index += 1) {
    if (!Number.isFinite(values[index])) return false;
  }
  return true;
}

/** Selects max(90 days, two finite positive periods, finite positive extension). */
export function selectPredictionHorizonSec(
  osculatingPeriodSec: number,
  userHorizonSec?: number,
): number {
  if (userHorizonSec !== undefined && (!Number.isFinite(userHorizonSec) || userHorizonSec <= 0)) {
    throw new RangeError('user horizon must be positive and finite');
  }

  let horizonSec = PREDICTOR_BASE_HORIZON_SEC;
  if (Number.isFinite(osculatingPeriodSec) && osculatingPeriodSec > 0) {
    const twoPeriodsSec = 2 * osculatingPeriodSec;
    if (Number.isFinite(twoPeriodsSec) && twoPeriodsSec > horizonSec) horizonSec = twoPeriodsSec;
  }
  if (userHorizonSec !== undefined && userHorizonSec > horizonSec) {
    horizonSec = userHorizonSec;
  }
  return horizonSec;
}

/** Narrows an unknown structured-clone payload to a predictor request. */
export function isPredictorRequestMessage(
  value: unknown,
  bodyCount: number,
): value is PredictorRequestMessage {
  if (!isRecord(value) || !isValidBodyCount(bodyCount)) return false;
  if (
    !hasOnlyKeys(value, [
      'type',
      'requestId',
      'startTimeSec',
      'shipState',
      'osculatingPeriodSec',
      'userHorizonSec',
      'dominantBodyIndex',
      'targetBodyIndex',
    ]) ||
    value.type !== 'predict' ||
    !isRequestId(value.requestId) ||
    !Number.isFinite(value.startTimeSec) ||
    !isOwnedFloat64Array(value.shipState) ||
    value.shipState.length !== PREDICTOR_STATE_LENGTH ||
    !hasFiniteComponents(value.shipState) ||
    typeof value.osculatingPeriodSec !== 'number' ||
    !isBodyIndex(value.dominantBodyIndex, bodyCount)
  ) {
    return false;
  }
  if ('targetBodyIndex' in value && !isBodyIndex(value.targetBodyIndex, bodyCount)) {
    return false;
  }
  if ('userHorizonSec' in value) {
    if (typeof value.userHorizonSec !== 'number') return false;
    try {
      selectPredictionHorizonSec(value.osculatingPeriodSec, value.userHorizonSec);
    } catch {
      return false;
    }
  }
  return true;
}

function isEventCode(value: number): value is PredictorEventCodeValue {
  return (
    value === PredictorEventCode.SoiTransition ||
    value === PredictorEventCode.ClosestApproach ||
    value === PredictorEventCode.Impact
  );
}

function isNonNegativeFinite(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function hasValidPackedEvents(events: Float64Array, bodyCount: number): boolean {
  for (let offset = 0; offset < events.length; offset += PREDICTOR_EVENT_STRIDE) {
    const code = events[offset + PREDICTOR_EVENT_CODE_OFFSET] as number;
    const timeSec = events[offset + PREDICTOR_EVENT_TIME_SEC_OFFSET] as number;
    const bodyIndex = events[offset + PREDICTOR_EVENT_BODY_INDEX_OFFSET] as number;
    const secondaryBodyIndex = events[
      offset + PREDICTOR_EVENT_SECONDARY_BODY_INDEX_OFFSET
    ] as number;
    const distanceKm = events[offset + PREDICTOR_EVENT_DISTANCE_KM_OFFSET] as number;
    const timeToImpactSec = events[offset + PREDICTOR_EVENT_TIME_TO_IMPACT_SEC_OFFSET] as number;

    if (
      !isEventCode(code) ||
      !Number.isFinite(timeSec) ||
      !isBodyIndex(bodyIndex, bodyCount) ||
      !isBodyIndex(secondaryBodyIndex, bodyCount)
    ) {
      return false;
    }
    if (code === PredictorEventCode.SoiTransition) {
      if (!Number.isNaN(distanceKm) || !Number.isNaN(timeToImpactSec)) return false;
    } else if (code === PredictorEventCode.ClosestApproach) {
      if (
        !isCatalogBodyIndex(bodyIndex, bodyCount) ||
        secondaryBodyIndex !== -1 ||
        !isNonNegativeFinite(distanceKm) ||
        !Number.isNaN(timeToImpactSec)
      ) {
        return false;
      }
    } else if (
      !isCatalogBodyIndex(bodyIndex, bodyCount) ||
      secondaryBodyIndex !== -1 ||
      !isNonNegativeFinite(distanceKm) ||
      !isNonNegativeFinite(timeToImpactSec)
    ) {
      return false;
    }
  }
  return true;
}

/** Narrows an unknown worker payload to a packed predictor success response. */
export function isPredictorSuccessMessage(
  value: unknown,
  bodyCount: number,
): value is PredictorSuccessMessage {
  if (!isRecord(value) || !isValidBodyCount(bodyCount)) return false;
  if (
    !hasOnlyKeys(value, ['type', 'requestId', 'points', 'events']) ||
    value.type !== 'success' ||
    !isRequestId(value.requestId) ||
    !isOwnedFloat64Array(value.points) ||
    value.points.length === 0 ||
    value.points.length % PREDICTOR_POINT_STRIDE !== 0 ||
    value.points.length > PREDICTOR_MAX_POINTS * PREDICTOR_POINT_STRIDE ||
    !hasFiniteComponents(value.points) ||
    !isOwnedFloat64Array(value.events) ||
    value.points.buffer === value.events.buffer ||
    value.events.length % PREDICTOR_EVENT_STRIDE !== 0
  ) {
    return false;
  }
  return hasValidPackedEvents(value.events, bodyCount);
}

/** Narrows an unknown worker payload to a deterministic predictor error response. */
export function isPredictorErrorMessage(value: unknown): value is PredictorErrorMessage {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['type', 'requestId', 'message']) &&
    value.type === 'error' &&
    isRequestId(value.requestId) &&
    typeof value.message === 'string' &&
    value.message.length > 0
  );
}

/** Returns the request buffer whose ownership is transferred to the worker. */
export function getPredictorRequestTransferList(message: PredictorRequestMessage): ArrayBuffer[] {
  return [message.shipState.buffer];
}

/** Returns packed result buffers, or no transfers for an error response. */
export function getPredictorResponseTransferList(message: PredictorResponseMessage): ArrayBuffer[] {
  return message.type === 'success' ? [message.points.buffer, message.events.buffer] : [];
}
