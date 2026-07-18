import type { SimSnapshot } from '../sim/simulationSnapshot.js';
import {
  isPredictorErrorMessage,
  isPredictorSuccessMessage,
  PREDICTOR_STATE_LENGTH,
  type PredictorRequestMessage,
  type PredictorResponseMessage,
} from '../workers/predictorProtocol.js';

export const TRAJECTORY_PREDICTOR_DEBOUNCE_MS = 500;

/** Worker subset used by the browser-independent trajectory client. */
export interface TrajectoryPredictorWorkerPort {
  addEventListener(
    type: 'message' | 'messageerror',
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  addEventListener(type: 'error', listener: (event: ErrorEvent) => void): void;
  removeEventListener(
    type: 'message' | 'messageerror',
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  removeEventListener(type: 'error', listener: (event: ErrorEvent) => void): void;
  postMessage(message: PredictorRequestMessage, transfer: Transferable[]): void;
  terminate?(): void;
}

/** Snapshot fields read only when a debounced prediction is actually dispatched. */
export interface TrajectoryPredictionSnapshotView extends Pick<
  SimSnapshot,
  'simTimeSec' | 'shipState' | 'dominantBodyIndex' | 'targetBodyIndex'
> {
  readonly osculatingElements: Pick<SimSnapshot['osculatingElements'], 'periodSec'>;
}

export type TrajectoryPredictionResultListener = (result: PredictorResponseMessage) => void;

export interface TrajectoryPredictorClientOptions {
  readonly now?: () => number;
  readonly ownsPort?: boolean;
}

/** Allocation-free frame-loop facade around debounced trajectory worker jobs. */
export interface TrajectoryPredictorClient {
  invalidate(): void;
  invalidateForWarpElapsed(): void;
  update(snapshot: TrajectoryPredictionSnapshotView, userHorizonSec?: number): void;
  dispose(): void;
}

function readPerformanceNow(): number {
  return performance.now();
}

class DefaultTrajectoryPredictorClient implements TrajectoryPredictorClient {
  private dirty = false;
  private disposed = false;
  private latestInvalidationMs = 0;
  private invalidationVersion = 0;
  private pendingRequestId = -1;
  private lastRequestId = 0;
  private readonly now: () => number;
  private readonly ownsPort: boolean;
  private readonly messageListener: (event: MessageEvent<unknown>) => void;
  private readonly errorListener: (event: ErrorEvent) => void;
  private readonly messageErrorListener: (event: MessageEvent<unknown>) => void;

  constructor(
    private readonly port: TrajectoryPredictorWorkerPort,
    private readonly bodyCount: number,
    private readonly onResult: TrajectoryPredictionResultListener,
    options: TrajectoryPredictorClientOptions,
  ) {
    if (!Number.isInteger(bodyCount) || bodyCount < 0) {
      throw new RangeError('body count must be a non-negative integer');
    }
    this.now = options.now ?? readPerformanceNow;
    this.ownsPort = options.ownsPort ?? false;
    this.messageListener = (event) => {
      this.handleMessage(event.data);
    };
    this.errorListener = () => {
      this.handleTransportFailure('trajectory predictor worker error');
    };
    this.messageErrorListener = () => {
      this.handleTransportFailure('trajectory predictor message error');
    };
    port.addEventListener('message', this.messageListener);
    port.addEventListener('error', this.errorListener);
    port.addEventListener('messageerror', this.messageErrorListener);
  }

  invalidate(): void {
    if (this.disposed) return;
    this.dirty = true;
    this.invalidationVersion += 1;
    this.latestInvalidationMs = this.now();
  }

  invalidateForWarpElapsed(): void {
    this.invalidate();
  }

  update(snapshot: TrajectoryPredictionSnapshotView, userHorizonSec?: number): void {
    if (
      this.disposed ||
      !this.dirty ||
      this.pendingRequestId >= 0 ||
      this.now() - this.latestInvalidationMs < TRAJECTORY_PREDICTOR_DEBOUNCE_MS
    ) {
      return;
    }
    this.dispatch(snapshot, userHorizonSec);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.dirty = false;
    this.port.removeEventListener('message', this.messageListener);
    this.port.removeEventListener('error', this.errorListener);
    this.port.removeEventListener('messageerror', this.messageErrorListener);
    if (this.ownsPort) this.port.terminate?.();
  }

  private dispatch(
    snapshot: TrajectoryPredictionSnapshotView,
    userHorizonSec: number | undefined,
  ): void {
    if (this.lastRequestId === Number.MAX_SAFE_INTEGER) {
      throw new RangeError('trajectory predictor request IDs exhausted');
    }

    const shipState = new Float64Array(PREDICTOR_STATE_LENGTH);
    for (let index = 0; index < PREDICTOR_STATE_LENGTH; index += 1) {
      shipState[index] = snapshot.shipState[index] as number;
    }
    const requestId = this.lastRequestId + 1;
    const dispatchInvalidationVersion = this.invalidationVersion;
    const message: PredictorRequestMessage =
      userHorizonSec === undefined
        ? {
            type: 'predict',
            requestId,
            startTimeSec: snapshot.simTimeSec,
            shipState,
            osculatingPeriodSec: snapshot.osculatingElements.periodSec,
            dominantBodyIndex: snapshot.dominantBodyIndex,
            targetBodyIndex: snapshot.targetBodyIndex,
          }
        : {
            type: 'predict',
            requestId,
            startTimeSec: snapshot.simTimeSec,
            shipState,
            osculatingPeriodSec: snapshot.osculatingElements.periodSec,
            userHorizonSec,
            dominantBodyIndex: snapshot.dominantBodyIndex,
            targetBodyIndex: snapshot.targetBodyIndex,
          };

    this.lastRequestId = requestId;
    try {
      this.port.postMessage(message, [shipState.buffer]);
    } catch {
      const isCurrent = this.invalidationVersion === dispatchInvalidationVersion;
      this.dirty = true;
      this.latestInvalidationMs = this.now();
      if (isCurrent) {
        this.onResult({
          type: 'error',
          requestId,
          message: 'trajectory predictor dispatch failed',
        });
      }
      return;
    }
    this.pendingRequestId = requestId;
    this.dirty = this.invalidationVersion !== dispatchInvalidationVersion;
  }

  private handleMessage(payload: unknown): void {
    if (this.disposed) return;
    if (!isPredictorSuccessMessage(payload, this.bodyCount) && !isPredictorErrorMessage(payload)) {
      return;
    }
    if (payload.requestId !== this.pendingRequestId) return;

    const isCurrent = !this.dirty;
    this.pendingRequestId = -1;
    if (isCurrent) this.onResult(payload);
  }

  private handleTransportFailure(message: string): void {
    if (this.disposed || this.pendingRequestId < 0) return;

    const requestId = this.pendingRequestId;
    const isCurrent = !this.dirty;
    this.pendingRequestId = -1;
    this.dirty = true;
    this.latestInvalidationMs = this.now();
    if (isCurrent) this.onResult({ type: 'error', requestId, message });
  }
}

/** Creates a debounced single-flight client and binds its stable message listener. */
export function createTrajectoryPredictorClient(
  port: TrajectoryPredictorWorkerPort,
  bodyCount: number,
  onResult: TrajectoryPredictionResultListener,
  options: TrajectoryPredictorClientOptions = {},
): TrajectoryPredictorClient {
  return new DefaultTrajectoryPredictorClient(port, bodyCount, onResult, options);
}
