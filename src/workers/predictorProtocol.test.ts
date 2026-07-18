import { describe, expect, it } from 'vitest';

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
  PREDICTOR_POINT_TIME_SEC_OFFSET,
  PREDICTOR_POINT_X_KM_OFFSET,
  PREDICTOR_POINT_Y_KM_OFFSET,
  PREDICTOR_POINT_Z_KM_OFFSET,
  PREDICTOR_POINT_STRIDE,
  PREDICTOR_STATE_LENGTH,
  PredictorEventCode,
  getPredictorRequestTransferList,
  getPredictorResponseTransferList,
  isPredictorErrorMessage,
  isPredictorRequestMessage,
  isPredictorSuccessMessage,
  selectPredictionHorizonSec,
  type PredictorRequestMessage,
  type PredictorSuccessMessage,
} from './predictorProtocol.js';

const BODY_COUNT = 3;

function createRequest(): PredictorRequestMessage {
  return {
    type: 'predict',
    requestId: 0,
    startTimeSec: 12,
    shipState: new Float64Array([1, 2, 3, 4, 5, 6, 7]),
    osculatingPeriodSec: 100,
    dominantBodyIndex: 1,
    targetBodyIndex: 2,
  };
}

function createSuccess(): PredictorSuccessMessage {
  return {
    type: 'success',
    requestId: 0,
    points: new Float64Array([0, 1, 2, 3, 10, 4, 5, 6]),
    events: new Float64Array([
      PredictorEventCode.SoiTransition,
      2,
      1,
      2,
      Number.NaN,
      Number.NaN,
      PredictorEventCode.ClosestApproach,
      4,
      2,
      -1,
      50,
      Number.NaN,
      PredictorEventCode.Impact,
      6,
      2,
      -1,
      0,
      6,
    ]),
  };
}

describe('trajectory predictor protocol', () => {
  it('publishes the packed state, point, event, and output-size contract', () => {
    expect(PREDICTOR_STATE_LENGTH).toBe(7);
    expect(PREDICTOR_POINT_STRIDE).toBe(4);
    expect([
      PREDICTOR_POINT_TIME_SEC_OFFSET,
      PREDICTOR_POINT_X_KM_OFFSET,
      PREDICTOR_POINT_Y_KM_OFFSET,
      PREDICTOR_POINT_Z_KM_OFFSET,
    ]).toEqual([0, 1, 2, 3]);
    expect(PREDICTOR_EVENT_STRIDE).toBe(6);
    expect([
      PREDICTOR_EVENT_CODE_OFFSET,
      PREDICTOR_EVENT_TIME_SEC_OFFSET,
      PREDICTOR_EVENT_BODY_INDEX_OFFSET,
      PREDICTOR_EVENT_SECONDARY_BODY_INDEX_OFFSET,
      PREDICTOR_EVENT_DISTANCE_KM_OFFSET,
      PREDICTOR_EVENT_TIME_TO_IMPACT_SEC_OFFSET,
    ]).toEqual([0, 1, 2, 3, 4, 5]);
    expect(PREDICTOR_MAX_POINTS).toBe(2_000);
    expect(PREDICTOR_BASE_HORIZON_SEC).toBe(90 * 24 * 60 * 60);
    expect(PredictorEventCode).toEqual({ SoiTransition: 1, ClosestApproach: 2, Impact: 3 });
  });

  it('selects the greatest finite horizon from 90 days, two periods, and the user extension', () => {
    expect(selectPredictionHorizonSec(100)).toBe(PREDICTOR_BASE_HORIZON_SEC);
    expect(selectPredictionHorizonSec(PREDICTOR_BASE_HORIZON_SEC)).toBe(
      2 * PREDICTOR_BASE_HORIZON_SEC,
    );
    expect(selectPredictionHorizonSec(100, 3 * PREDICTOR_BASE_HORIZON_SEC)).toBe(
      3 * PREDICTOR_BASE_HORIZON_SEC,
    );
    expect(selectPredictionHorizonSec(Number.NaN)).toBe(PREDICTOR_BASE_HORIZON_SEC);
    expect(selectPredictionHorizonSec(Number.POSITIVE_INFINITY)).toBe(PREDICTOR_BASE_HORIZON_SEC);
    expect(selectPredictionHorizonSec(-1)).toBe(PREDICTOR_BASE_HORIZON_SEC);
  });

  it('rejects a supplied user horizon unless it is positive and finite', () => {
    expect(() => selectPredictionHorizonSec(100, 0)).toThrow(/user horizon/u);
    expect(() => selectPredictionHorizonSec(100, -1)).toThrow(/user horizon/u);
    expect(() => selectPredictionHorizonSec(100, Number.NaN)).toThrow(/user horizon/u);
    expect(() => selectPredictionHorizonSec(100, Number.POSITIVE_INFINITY)).toThrow(
      /user horizon/u,
    );
  });

  it('validates predictor requests and permits unavailable body indices', () => {
    expect(
      isPredictorRequestMessage(
        { ...createRequest(), requestId: Number.MAX_SAFE_INTEGER },
        BODY_COUNT,
      ),
    ).toBe(true);
    expect(
      isPredictorRequestMessage(
        {
          ...createRequest(),
          osculatingPeriodSec: Number.POSITIVE_INFINITY,
          dominantBodyIndex: -1,
          targetBodyIndex: -1,
        },
        BODY_COUNT,
      ),
    ).toBe(true);
    const withoutTarget = createRequest();
    Reflect.deleteProperty(withoutTarget, 'targetBodyIndex');
    expect(isPredictorRequestMessage(withoutTarget, BODY_COUNT)).toBe(true);
    expect(
      isPredictorRequestMessage({ ...createRequest(), testHorizonSec: 21_600 }, BODY_COUNT),
    ).toBe(true);
    expect(isPredictorRequestMessage({ ...createRequest(), testPointCount: 128 }, BODY_COUNT)).toBe(
      true,
    );
  });

  it('rejects malformed request identifiers, times, states, and body indices', () => {
    expect(isPredictorRequestMessage({ ...createRequest(), requestId: -1 }, BODY_COUNT)).toBe(
      false,
    );
    expect(isPredictorRequestMessage({ ...createRequest(), requestId: 1.5 }, BODY_COUNT)).toBe(
      false,
    );
    expect(
      isPredictorRequestMessage({ ...createRequest(), startTimeSec: Number.NaN }, BODY_COUNT),
    ).toBe(false);
    expect(
      isPredictorRequestMessage(
        { ...createRequest(), shipState: new Float64Array(PREDICTOR_STATE_LENGTH - 1) },
        BODY_COUNT,
      ),
    ).toBe(false);
    const nonFiniteState = createRequest();
    nonFiniteState.shipState[3] = Number.POSITIVE_INFINITY;
    expect(isPredictorRequestMessage(nonFiniteState, BODY_COUNT)).toBe(false);
    if (typeof SharedArrayBuffer === 'function') {
      const sharedState = new Float64Array(
        new SharedArrayBuffer(PREDICTOR_STATE_LENGTH * Float64Array.BYTES_PER_ELEMENT),
      );
      sharedState.fill(1);
      expect(
        isPredictorRequestMessage({ ...createRequest(), shipState: sharedState }, BODY_COUNT),
      ).toBe(false);
    }
    const oversizedStateBuffer = new ArrayBuffer((PREDICTOR_STATE_LENGTH + 1) * 8);
    const partialStateView = new Float64Array(oversizedStateBuffer, 8, PREDICTOR_STATE_LENGTH);
    partialStateView.fill(1);
    expect(
      isPredictorRequestMessage({ ...createRequest(), shipState: partialStateView }, BODY_COUNT),
    ).toBe(false);
    expect(
      isPredictorRequestMessage({ ...createRequest(), dominantBodyIndex: BODY_COUNT }, BODY_COUNT),
    ).toBe(false);
    expect(
      isPredictorRequestMessage({ ...createRequest(), dominantBodyIndex: -2 }, BODY_COUNT),
    ).toBe(false);
    expect(
      isPredictorRequestMessage({ ...createRequest(), targetBodyIndex: BODY_COUNT }, BODY_COUNT),
    ).toBe(false);
    expect(isPredictorRequestMessage({ ...createRequest(), userHorizonSec: 0 }, BODY_COUNT)).toBe(
      false,
    );
    expect(
      isPredictorRequestMessage({ ...createRequest(), userHorizonSec: undefined }, BODY_COUNT),
    ).toBe(false);
    expect(
      isPredictorRequestMessage(
        { ...createRequest(), requestId: Number.MAX_SAFE_INTEGER + 1 },
        BODY_COUNT,
      ),
    ).toBe(false);
    expect(isPredictorRequestMessage({ ...createRequest(), testHorizonSec: 0 }, BODY_COUNT)).toBe(
      false,
    );
    expect(
      isPredictorRequestMessage(
        { ...createRequest(), testHorizonSec: PREDICTOR_BASE_HORIZON_SEC + 1 },
        BODY_COUNT,
      ),
    ).toBe(false);
    expect(isPredictorRequestMessage({ ...createRequest(), testPointCount: 1 }, BODY_COUNT)).toBe(
      false,
    );
    expect(
      isPredictorRequestMessage({ ...createRequest(), testPointCount: 128.5 }, BODY_COUNT),
    ).toBe(false);
    expect(
      isPredictorRequestMessage(
        { ...createRequest(), testPointCount: PREDICTOR_MAX_POINTS + 1 },
        BODY_COUNT,
      ),
    ).toBe(false);
  });

  it('validates packed success and deterministic error messages', () => {
    expect(isPredictorSuccessMessage(createSuccess(), BODY_COUNT)).toBe(true);
    expect(
      isPredictorSuccessMessage(
        { ...createSuccess(), points: new Float64Array([0, 1, 2, 3]) },
        BODY_COUNT,
      ),
    ).toBe(false);
    expect(
      isPredictorSuccessMessage(
        { ...createSuccess(), points: new Float64Array([0, 1, 2, 3, 0, 4, 5, 6]) },
        BODY_COUNT,
      ),
    ).toBe(false);
    expect(
      isPredictorSuccessMessage(
        { ...createSuccess(), points: new Float64Array([10, 1, 2, 3, 0, 4, 5, 6]) },
        BODY_COUNT,
      ),
    ).toBe(false);
    expect(
      isPredictorSuccessMessage(
        { ...createSuccess(), points: new Float64Array(PREDICTOR_POINT_STRIDE - 1) },
        BODY_COUNT,
      ),
    ).toBe(false);
    const success = createSuccess();
    const oversizedPointsBuffer = new ArrayBuffer(
      success.points.byteLength + Float64Array.BYTES_PER_ELEMENT,
    );
    const partialPoints = new Float64Array(
      oversizedPointsBuffer,
      Float64Array.BYTES_PER_ELEMENT,
      success.points.length,
    );
    partialPoints.set(success.points);
    expect(isPredictorSuccessMessage({ ...success, points: partialPoints }, BODY_COUNT)).toBe(
      false,
    );
    if (typeof SharedArrayBuffer === 'function') {
      const sharedPoints = new Float64Array(new SharedArrayBuffer(success.points.byteLength));
      sharedPoints.set(success.points);
      expect(isPredictorSuccessMessage({ ...success, points: sharedPoints }, BODY_COUNT)).toBe(
        false,
      );

      const sharedEvents = new Float64Array(new SharedArrayBuffer(success.events.byteLength));
      sharedEvents.set(success.events);
      expect(isPredictorSuccessMessage({ ...success, events: sharedEvents }, BODY_COUNT)).toBe(
        false,
      );
    }
    const aliasedBuffer = new ArrayBuffer(12 * Float64Array.BYTES_PER_ELEMENT);
    const aliasedPoints = new Float64Array(aliasedBuffer);
    const aliasedEvents = new Float64Array(aliasedBuffer);
    aliasedEvents.set([
      PredictorEventCode.Impact,
      2,
      1,
      -1,
      0,
      2,
      PredictorEventCode.Impact,
      3,
      1,
      -1,
      0,
      3,
    ]);
    expect(
      isPredictorSuccessMessage(
        { type: 'success', requestId: 1, points: aliasedPoints, events: aliasedEvents },
        BODY_COUNT,
      ),
    ).toBe(false);
    expect(
      isPredictorSuccessMessage(
        {
          ...createSuccess(),
          points: new Float64Array((PREDICTOR_MAX_POINTS + 1) * PREDICTOR_POINT_STRIDE),
        },
        BODY_COUNT,
      ),
    ).toBe(false);
    const invalidEventBody = createSuccess();
    invalidEventBody.events[2] = BODY_COUNT;
    expect(isPredictorSuccessMessage(invalidEventBody, BODY_COUNT)).toBe(false);
    const missingClosestApproachBody = createSuccess();
    missingClosestApproachBody.events[PREDICTOR_EVENT_STRIDE + 2] = -1;
    expect(isPredictorSuccessMessage(missingClosestApproachBody, BODY_COUNT)).toBe(false);
    const closestApproachSecondaryBody = createSuccess();
    closestApproachSecondaryBody.events[PREDICTOR_EVENT_STRIDE + 3] = 1;
    expect(isPredictorSuccessMessage(closestApproachSecondaryBody, BODY_COUNT)).toBe(false);
    expect(isPredictorErrorMessage({ type: 'error', requestId: 7, message: 'failed' })).toBe(true);
    expect(isPredictorErrorMessage({ type: 'error', requestId: -1, message: 'failed' })).toBe(
      false,
    );
    expect(isPredictorErrorMessage({ type: 'error', requestId: 7, message: '' })).toBe(false);
  });

  it('returns only owned ArrayBuffers in transfer lists', () => {
    const request = createRequest();
    const success = createSuccess();

    expect(getPredictorRequestTransferList(request)).toEqual([request.shipState.buffer]);
    expect(getPredictorResponseTransferList(success)).toEqual([
      success.points.buffer,
      success.events.buffer,
    ]);
    expect(
      getPredictorResponseTransferList({ type: 'error', requestId: 0, message: 'failed' }),
    ).toEqual([]);
  });
});
