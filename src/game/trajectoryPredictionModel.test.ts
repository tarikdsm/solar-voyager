import { describe, expect, it } from 'vitest';

import {
  PREDICTOR_EVENT_STRIDE,
  PREDICTOR_POINT_STRIDE,
  PredictorEventCode,
} from '../workers/predictorProtocol.js';
import {
  readTrajectoryEventSummary,
  writePredictionPointsInto,
  writeTrajectoryMarkersInto,
  writeTrajectorySegmentBodiesInto,
} from './trajectoryPredictionModel.js';

function createPoints(): Float64Array {
  return new Float64Array([
    0, 0, 0, 0,
    10, 10, 20, 30,
    20, 20, 40, 60,
  ]);
}

function event(
  code: number,
  timeSec: number,
  bodyIndex: number,
  secondaryBodyIndex = -1,
  distanceKm = Number.NaN,
  timeToImpactSec = Number.NaN,
): number[] {
  return [code, timeSec, bodyIndex, secondaryBodyIndex, distanceKm, timeToImpactSec];
}

describe('trajectory prediction presentation model', () => {
  it('copies packed float64 point positions into stable xyz storage', () => {
    const output = new Float64Array(12).fill(-1);

    const pointCount = writePredictionPointsInto(output, createPoints());

    expect(pointCount).toBe(3);
    expect(Array.from(output)).toEqual([0, 0, 0, 10, 20, 30, 20, 40, 60, -1, -1, -1]);
  });

  it('places exact and interpolated event markers on the rendered polyline', () => {
    const points = createPoints();
    const events = new Float64Array([
      ...event(PredictorEventCode.SoiTransition, 10, 0, 1),
      ...event(PredictorEventCode.ClosestApproach, 5, 4, -1, 123),
      ...event(PredictorEventCode.Impact, 20, 2, -1, 6_000, 20),
    ]);
    const positions = new Float64Array(12).fill(-1);
    const codes = new Float32Array(4).fill(-1);
    const bodies = new Float32Array(4).fill(-1);

    const markerCount = writeTrajectoryMarkersInto(
      positions,
      codes,
      bodies,
      points,
      events,
    );

    expect(markerCount).toBe(3);
    expect(Array.from(positions.slice(0, 9))).toEqual([
      10, 20, 30,
      5, 10, 15,
      20, 40, 60,
    ]);
    expect(Array.from(codes.slice(0, 3))).toEqual([
      PredictorEventCode.SoiTransition,
      PredictorEventCode.ClosestApproach,
      PredictorEventCode.Impact,
    ]);
    expect(Array.from(bodies.slice(0, 3))).toEqual([1, 4, 2]);
    expect(Array.from(positions.slice(9))).toEqual([-1, -1, -1]);
  });

  it('skips event times outside the polyline instead of extrapolating', () => {
    const positions = new Float64Array(6).fill(99);
    const codes = new Float32Array(2).fill(99);
    const bodies = new Float32Array(2).fill(99);
    const events = new Float64Array([
      ...event(PredictorEventCode.ClosestApproach, -1, 2),
      ...event(PredictorEventCode.Impact, 21, 3),
    ]);

    const markerCount = writeTrajectoryMarkersInto(
      positions,
      codes,
      bodies,
      createPoints(),
      events,
    );

    expect(markerCount).toBe(0);
    expect(Array.from(positions)).toEqual([99, 99, 99, 99, 99, 99]);
  });

  it('colors segments from chronological SOI records despite a trailing earlier event', () => {
    const events = new Float64Array([
      ...event(PredictorEventCode.SoiTransition, 10, 0, 1),
      ...event(PredictorEventCode.SoiTransition, 20, 1, 2),
      ...event(PredictorEventCode.ClosestApproach, 5, 4, -1, 123),
    ]);
    const bodies = new Int32Array(4).fill(-1);

    const segmentCount = writeTrajectorySegmentBodiesInto(bodies, createPoints(), events, 7);

    expect(segmentCount).toBe(2);
    expect(Array.from(bodies)).toEqual([0, 1, -1, -1]);
  });

  it('uses the current dominant body when there is no SOI event', () => {
    const bodies = new Int32Array(2).fill(-1);

    const segmentCount = writeTrajectorySegmentBodiesInto(
      bodies,
      createPoints(),
      new Float64Array(0),
      7,
    );

    expect(segmentCount).toBe(2);
    expect(Array.from(bodies)).toEqual([7, 7]);
  });

  it('reads closest approach and impact from event records without assuming global time order', () => {
    const events = new Float64Array([
      ...event(PredictorEventCode.SoiTransition, 10, 0, 1),
      ...event(PredictorEventCode.Impact, 20, 2, -1, 6_000, 20),
      ...event(PredictorEventCode.ClosestApproach, 5, 4, -1, 123),
    ]);

    expect(readTrajectoryEventSummary(events)).toEqual({
      closestApproachBodyIndex: 4,
      closestApproachTimeSec: 5,
      closestApproachDistanceKm: 123,
      impactBodyIndex: 2,
      impactTimeSec: 20,
    });
    expect(readTrajectoryEventSummary(new Float64Array(0))).toEqual({
      closestApproachBodyIndex: -1,
      closestApproachTimeSec: Number.NaN,
      closestApproachDistanceKm: Number.NaN,
      impactBodyIndex: -1,
      impactTimeSec: Number.NaN,
    });
  });

  it('rejects malformed packed strides and undersized output storage', () => {
    expect(() => writePredictionPointsInto(new Float64Array(9), new Float64Array(3))).toThrow(
      /point stride/u,
    );
    expect(() =>
      writeTrajectoryMarkersInto(
        new Float64Array(3),
        new Float32Array(1),
        new Float32Array(1),
        createPoints(),
        new Float64Array(PREDICTOR_EVENT_STRIDE - 1),
      ),
    ).toThrow(/event stride/u);
    expect(() =>
      writePredictionPointsInto(
        new Float64Array((createPoints().length / PREDICTOR_POINT_STRIDE) * 3 - 1),
        createPoints(),
      ),
    ).toThrow(/point output/u);
  });
});
