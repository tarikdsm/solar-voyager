import bodiesDocument from '../../data/bodies.json';

import {
  predictThrustFreeTrajectory,
  type ThrustFreeTrajectory,
  type ThrustFreeTrajectoryOptions,
} from '../sim/analysis/trajectoryPredictor.js';
import { compileRailsCatalog } from '../sim/propagation/rails.js';
import {
  getPredictorResponseTransferList,
  isPredictorRequestMessage,
  PREDICTOR_MAX_POINTS,
  selectPredictionHorizonSec,
  type PredictorErrorMessage,
  type PredictorResponseMessage,
  type PredictorSuccessMessage,
} from './predictorProtocol.js';

/** Safe correlation value used only when a malformed payload has no valid request ID. */
export const PREDICTOR_INVALID_REQUEST_ID_FALLBACK = 0;

export type PredictorExecutor = (options: ThrustFreeTrajectoryOptions) => ThrustFreeTrajectory;

/** Minimal dedicated-worker surface needed by the predictor runtime. */
export interface PredictorWorkerPort {
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  postMessage(message: PredictorResponseMessage, options?: StructuredSerializeOptions): void;
}

function extractSafeRequestId(payload: unknown): number {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return PREDICTOR_INVALID_REQUEST_ID_FALLBACK;
  }
  const requestId = (payload as Record<string, unknown>).requestId;
  return Number.isSafeInteger(requestId) && (requestId as number) >= 0
    ? (requestId as number)
    : PREDICTOR_INVALID_REQUEST_ID_FALLBACK;
}

function postResponse(port: PredictorWorkerPort, response: PredictorResponseMessage): void {
  port.postMessage(response, { transfer: getPredictorResponseTransferList(response) });
}

/**
 * Compiles immutable canonical setup once, then handles independent prediction jobs.
 * Each listener invocation catches its own failure so later jobs remain usable.
 */
export function createPredictorWorkerRuntime(
  port: PredictorWorkerPort,
  execute: PredictorExecutor = predictThrustFreeTrajectory,
): void {
  const catalog = compileRailsCatalog(bodiesDocument.bodies);
  const collisionRadiiKm = new Float64Array(catalog.bodyCount);
  for (let bodyIndex = 0; bodyIndex < catalog.bodyCount; bodyIndex += 1) {
    const body = bodiesDocument.bodies[bodyIndex];
    if (body === undefined) throw new Error(`missing canonical body at index ${bodyIndex}`);
    collisionRadiiKm[bodyIndex] = body.meanRadiusKm + (body.surface.atmosphereTopKm ?? 0);
  }

  port.addEventListener('message', (event) => {
    const payload = event.data;
    const requestId = extractSafeRequestId(payload);
    if (!isPredictorRequestMessage(payload, catalog.bodyCount)) {
      const response: PredictorErrorMessage = {
        type: 'error',
        requestId,
        message: 'invalid predictor request',
      };
      postResponse(port, response);
      return;
    }

    try {
      const result = execute({
        catalog,
        collisionRadiiKm,
        startTimeSec: payload.startTimeSec,
        horizonSec: selectPredictionHorizonSec(payload.osculatingPeriodSec, payload.userHorizonSec),
        shipState: payload.shipState,
        dominantBodyIndex: payload.dominantBodyIndex,
        targetBodyIndex: payload.targetBodyIndex,
        outputPointCount: PREDICTOR_MAX_POINTS,
      });
      const response: PredictorSuccessMessage = {
        type: 'success',
        requestId: payload.requestId,
        points: result.points,
        events: result.events,
      };
      postResponse(port, response);
    } catch {
      const response: PredictorErrorMessage = {
        type: 'error',
        requestId: payload.requestId,
        message: 'trajectory prediction failed',
      };
      postResponse(port, response);
    }
  });
}
