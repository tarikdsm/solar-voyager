import { describe, expect, it } from 'vitest';

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
  compileRailsCatalog,
  createRailsState,
  createRailsWorkspace,
  evaluateRailsInto,
  type CompiledRailsCatalog,
} from '../propagation/rails.js';
import { coordinateVelocityInto, createRelativisticDerivative } from '../ship/relativity.js';
import { predictThrustFreeTrajectory } from './trajectoryPredictor.js';

function staticCatalog(muKm3S2 = Number.MIN_VALUE): CompiledRailsCatalog {
  return compileRailsCatalog([
    { id: 'root', parentId: null, muKm3S2, soiRadiusKm: null, elements: null },
  ]);
}

function hierarchyCatalog(): CompiledRailsCatalog {
  return compileRailsCatalog([
    { id: 'root', parentId: null, muKm3S2: 1e-300, soiRadiusKm: null, elements: null },
    {
      id: 'child',
      parentId: 'root',
      muKm3S2: 1e-302,
      soiRadiusKm: 10,
      elements: {
        semiMajorAxisKm: 100,
        eccentricity: 0,
        inclinationRad: 0,
        longitudeAscendingNodeRad: 0,
        argumentPeriapsisRad: 0,
        meanAnomalyRad: 0,
      },
    },
  ]);
}

function eventOffset(events: Float64Array, code: number): number {
  for (let offset = 0; offset < events.length; offset += PREDICTOR_EVENT_STRIDE) {
    if (events[offset + PREDICTOR_EVENT_CODE_OFFSET] === code) return offset;
  }
  return -1;
}

function propagateCanonically(
  catalog: CompiledRailsCatalog,
  initialState: Float64Array,
  startTimeSec: number,
  endTimeSec: number,
): Float64Array {
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
      outputAcceleration.fill(0);
    },
  );
  const output = new Float64Array(initialState.length);
  const result = propagate(
    output,
    initialState,
    startTimeSec,
    endTimeSec,
    derivative,
    createShipDp54Tolerance(),
    createDp54Workspace(initialState.length),
    createDp54Result(),
  );
  expect(result.reachedEnd).toBe(true);
  return output;
}

describe('thrust-free trajectory predictor — physics-spec.md §6', () => {
  it('samples both endpoints at uniform coordinate-time spacing', () => {
    const result = predictThrustFreeTrajectory({
      catalog: staticCatalog(),
      collisionRadiiKm: new Float64Array([1]),
      startTimeSec: 100,
      horizonSec: 10,
      shipState: new Float64Array([1_000, 0, 0, 1, 0, 0, 0]),
      dominantBodyIndex: 0,
      outputPointCount: 3,
    });

    expect(result.points.length).toBe(3 * PREDICTOR_POINT_STRIDE);
    expect(result.points[0]).toBe(100);
    expect(result.points[PREDICTOR_POINT_STRIDE]).toBe(105);
    expect(result.points[2 * PREDICTOR_POINT_STRIDE]).toBe(110);
    expect(result.points[1]).toBe(1_000);
  });

  it('clamps requested output to the 2,000-point protocol cap', () => {
    const result = predictThrustFreeTrajectory({
      catalog: staticCatalog(),
      collisionRadiiKm: new Float64Array([0]),
      startTimeSec: 0,
      horizonSec: 1,
      shipState: new Float64Array([1_000, 0, 0, 0, 0, 0, 0]),
      dominantBodyIndex: 0,
      outputPointCount: PREDICTOR_MAX_POINTS + 500,
    });

    expect(result.points.length / PREDICTOR_POINT_STRIDE).toBe(PREDICTOR_MAX_POINTS);
    expect(result.points[0]).toBe(0);
    expect(result.points[result.points.length - PREDICTOR_POINT_STRIDE]).toBe(1);
  });

  it('matches canonical DP54, rails, n-body, and zero-thrust propagation', () => {
    const catalog = staticCatalog(398_600.4418);
    const initialState = new Float64Array([7_000, 0, 0, 0, 7.546, 0, 0]);
    const expected = propagateCanonically(catalog, initialState, 20, 140);

    const result = predictThrustFreeTrajectory({
      catalog,
      collisionRadiiKm: new Float64Array([1]),
      startTimeSec: 20,
      horizonSec: 120,
      shipState: initialState,
      dominantBodyIndex: 0,
      outputPointCount: 2,
    });

    const finalOffset = result.points.length - PREDICTOR_POINT_STRIDE;
    expect(result.points[finalOffset]).toBe(140);
    expect(result.points[finalOffset + 1]).toBeCloseTo(expected[0] as number, 11);
    expect(result.points[finalOffset + 2]).toBeCloseTo(expected[1] as number, 11);
    expect(result.points[finalOffset + 3]).toBeCloseTo(expected[2] as number, 11);
  });

  it('encodes transitions selected by the existing SOI hysteresis policy', () => {
    const result = predictThrustFreeTrajectory({
      catalog: hierarchyCatalog(),
      collisionRadiiKm: new Float64Array([0.1, 0.1]),
      startTimeSec: 0,
      horizonSec: 12,
      shipState: new Float64Array([85, 0, 0, 2, 0, 0, 0]),
      dominantBodyIndex: 0,
      outputPointCount: 4,
    });

    const offset = eventOffset(result.events, PredictorEventCode.SoiTransition);
    expect(offset).toBeGreaterThanOrEqual(0);
    expect(result.events[offset + PREDICTOR_EVENT_TIME_SEC_OFFSET]).toBe(4);
    expect(result.events[offset + PREDICTOR_EVENT_BODY_INDEX_OFFSET]).toBe(0);
    expect(result.events[offset + PREDICTOR_EVENT_SECONDARY_BODY_INDEX_OFFSET]).toBe(1);
    expect(result.events[offset + PREDICTOR_EVENT_DISTANCE_KM_OFFSET]).toBeNaN();
    expect(result.events[offset + PREDICTOR_EVENT_TIME_TO_IMPACT_SEC_OFFSET]).toBeNaN();
  });

  it('reports the minimum sampled target-centre distance', () => {
    const coordinateVelocityKmS = coordinateVelocityInto(new Float64Array(3), 1, 0, 0)[0] as number;
    const result = predictThrustFreeTrajectory({
      catalog: hierarchyCatalog(),
      collisionRadiiKm: new Float64Array([0.1, 0.1]),
      startTimeSec: 0,
      horizonSec: 18,
      shipState: new Float64Array([90, 10, 0, 1, 0, 0, 0]),
      dominantBodyIndex: 0,
      targetBodyIndex: 1,
      outputPointCount: 7,
    });

    const offset = eventOffset(result.events, PredictorEventCode.ClosestApproach);
    expect(offset).toBeGreaterThanOrEqual(0);
    expect(result.events[offset + PREDICTOR_EVENT_TIME_SEC_OFFSET]).toBe(9);
    expect(result.events[offset + PREDICTOR_EVENT_BODY_INDEX_OFFSET]).toBe(1);
    expect(result.events[offset + PREDICTOR_EVENT_SECONDARY_BODY_INDEX_OFFSET]).toBe(-1);
    expect(result.events[offset + PREDICTOR_EVENT_DISTANCE_KM_OFFSET]).toBeCloseTo(
      Math.hypot(10 - 9 * coordinateVelocityKmS, 10),
      12,
    );
    expect(result.events[offset + PREDICTOR_EVENT_TIME_TO_IMPACT_SEC_OFFSET]).toBeNaN();
  });

  it('interpolates a bracketed outside-to-inside crossing and stops at first impact', () => {
    const coordinateVelocityKmS = coordinateVelocityInto(new Float64Array(3), 2, 0, 0)[0] as number;
    const result = predictThrustFreeTrajectory({
      catalog: staticCatalog(),
      collisionRadiiKm: new Float64Array([5]),
      startTimeSec: 0,
      horizonSec: 10,
      shipState: new Float64Array([-10, 0, 0, 2, 0, 0, 0]),
      dominantBodyIndex: 0,
      outputPointCount: 6,
    });

    expect(result.points.length).toBe(3 * PREDICTOR_POINT_STRIDE);
    expect(result.points[2 * PREDICTOR_POINT_STRIDE]).toBeCloseTo(5 / coordinateVelocityKmS, 12);
    expect(result.points[2 * PREDICTOR_POINT_STRIDE + 1]).toBeCloseTo(-5, 12);

    const offset = eventOffset(result.events, PredictorEventCode.Impact);
    expect(offset).toBeGreaterThanOrEqual(0);
    expect(result.events[offset + PREDICTOR_EVENT_TIME_SEC_OFFSET]).toBeCloseTo(
      5 / coordinateVelocityKmS,
      12,
    );
    expect(result.events[offset + PREDICTOR_EVENT_BODY_INDEX_OFFSET]).toBe(0);
    expect(result.events[offset + PREDICTOR_EVENT_SECONDARY_BODY_INDEX_OFFSET]).toBe(-1);
    expect(result.events[offset + PREDICTOR_EVENT_DISTANCE_KM_OFFSET]).toBe(5);
    expect(result.events[offset + PREDICTOR_EVENT_TIME_TO_IMPACT_SEC_OFFSET]).toBeCloseTo(
      5 / coordinateVelocityKmS,
      12,
    );
  });

  it('detects an outside-to-outside segment that passes through a body', () => {
    const coordinateVelocityKmS = coordinateVelocityInto(new Float64Array(3), 4, 0, 0)[0] as number;
    const result = predictThrustFreeTrajectory({
      catalog: staticCatalog(),
      collisionRadiiKm: new Float64Array([5]),
      startTimeSec: 0,
      horizonSec: 10,
      shipState: new Float64Array([-20, 0, 0, 4, 0, 0, 0]),
      dominantBodyIndex: 0,
      outputPointCount: 2,
    });

    const offset = eventOffset(result.events, PredictorEventCode.Impact);
    expect(offset).toBeGreaterThanOrEqual(0);
    expect(result.points[PREDICTOR_POINT_STRIDE]).toBeCloseTo(15 / coordinateVelocityKmS, 12);
    expect(result.points[PREDICTOR_POINT_STRIDE + 1]).toBeCloseTo(-5, 12);
    expect(result.events[offset + PREDICTOR_EVENT_TIME_SEC_OFFSET]).toBeCloseTo(
      15 / coordinateVelocityKmS,
      12,
    );
  });

  it('rejects collision-radius storage that does not match bodyCount', () => {
    expect(() =>
      predictThrustFreeTrajectory({
        catalog: hierarchyCatalog(),
        collisionRadiiKm: new Float64Array([1]),
        startTimeSec: 0,
        horizonSec: 1,
        shipState: new Float64Array([1_000, 0, 0, 0, 0, 0, 0]),
        dominantBodyIndex: 0,
        outputPointCount: 2,
      }),
    ).toThrow('collision radii must contain 2 values');
  });
});
