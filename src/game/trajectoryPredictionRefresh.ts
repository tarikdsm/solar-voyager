import {
  PREDICTOR_POINT_STRIDE,
  PREDICTOR_POINT_TIME_SEC_OFFSET,
} from '../workers/predictorProtocol.js';

/** Latches one warp-elapsed invalidation per displayed prediction. */
export class TrajectoryPredictionRefresh {
  private startTimeSec = Number.NaN;
  private sampleIntervalSec = Number.NaN;
  private invalidated = false;

  acceptPrediction(points: Float64Array): void {
    if (points.length % PREDICTOR_POINT_STRIDE !== 0) {
      throw new RangeError('trajectory refresh points must match the predictor point stride');
    }
    if (points.length < PREDICTOR_POINT_STRIDE * 2) {
      throw new RangeError('trajectory refresh requires at least two prediction points');
    }
    const startTimeSec = points[PREDICTOR_POINT_TIME_SEC_OFFSET] as number;
    const secondTimeSec = points[
      PREDICTOR_POINT_STRIDE + PREDICTOR_POINT_TIME_SEC_OFFSET
    ] as number;
    const sampleIntervalSec = secondTimeSec - startTimeSec;
    if (
      !Number.isFinite(startTimeSec) ||
      !Number.isFinite(secondTimeSec) ||
      !Number.isFinite(sampleIntervalSec) ||
      sampleIntervalSec <= 0
    ) {
      throw new RangeError('trajectory refresh sample interval must be finite and positive');
    }
    this.startTimeSec = startTimeSec;
    this.sampleIntervalSec = sampleIntervalSec;
    this.invalidated = false;
  }

  clear(): void {
    this.startTimeSec = Number.NaN;
    this.sampleIntervalSec = Number.NaN;
    this.invalidated = false;
  }

  update(simTimeSec: number, invalidateForWarpElapsed: () => void): void {
    if (!Number.isFinite(simTimeSec)) {
      throw new RangeError('trajectory refresh simulation time must be finite');
    }
    if (
      this.invalidated ||
      !Number.isFinite(this.startTimeSec) ||
      simTimeSec < this.startTimeSec + this.sampleIntervalSec
    ) {
      return;
    }
    this.invalidated = true;
    invalidateForWarpElapsed();
  }
}
