import { describe, expect, it, vi } from 'vitest';

import { TrajectoryPredictionRefresh } from './trajectoryPredictionRefresh.js';

function predictionPoints(startTimeSec = 100, intervalSec = 10): Float64Array {
  return new Float64Array([
    startTimeSec,
    1,
    2,
    3,
    startTimeSec + intervalSec,
    4,
    5,
    6,
    startTimeSec + intervalSec * 2,
    7,
    8,
    9,
  ]);
}

describe('TrajectoryPredictionRefresh', () => {
  it('invalidates once after one displayed sample interval and remains latched', () => {
    const refresh = new TrajectoryPredictionRefresh();
    const invalidate = vi.fn();
    refresh.acceptPrediction(predictionPoints());

    refresh.update(109.999, invalidate);
    expect(invalidate).not.toHaveBeenCalled();

    refresh.update(110, invalidate);
    refresh.update(120, invalidate);
    refresh.update(1_000, invalidate);
    expect(invalidate).toHaveBeenCalledOnce();
  });

  it('rearms on a new result and clears timing during replacement or error', () => {
    const refresh = new TrajectoryPredictionRefresh();
    const invalidate = vi.fn();
    refresh.acceptPrediction(predictionPoints());
    refresh.update(110, invalidate);
    refresh.acceptPrediction(predictionPoints(200, 20));
    refresh.update(219.999, invalidate);
    refresh.update(220, invalidate);
    expect(invalidate).toHaveBeenCalledTimes(2);

    refresh.clear();
    refresh.update(1_000, invalidate);
    expect(invalidate).toHaveBeenCalledTimes(2);
  });

  it('rejects malformed prediction points and non-finite simulation time', () => {
    const refresh = new TrajectoryPredictionRefresh();

    expect(() => refresh.acceptPrediction(new Float64Array([0, 1, 2, 3]))).toThrow(
      /two prediction points/u,
    );
    expect(() => refresh.acceptPrediction(predictionPoints(100, 0))).toThrow(/sample interval/u);
    expect(() => refresh.acceptPrediction(new Float64Array([0, 1, 2]))).toThrow(/point stride/u);
    expect(() => refresh.update(Number.NaN, () => undefined)).toThrow(/simulation time/u);
  });
});
