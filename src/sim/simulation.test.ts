import { describe, expect, it } from 'vitest';

import { SPEED_OF_LIGHT_KM_S } from '../core/constants.js';
import { WARP_LADDER } from '../core/time.js';
import type { Dp54Tolerance } from './propagation/dp54.js';
import { compileRailsCatalog } from './propagation/rails.js';
import { SimulationCore } from './simulation.js';
import { WarpClampReason, type SimSnapshot } from './simulationSnapshot.js';
import { writeForwardFromQuaternionInto } from './ship/attitude.js';
import { DEFAULT_MAX_PROPER_ACCELERATION_M_S2 } from './ship/thrust.js';

const EARTH_MU_KM3_S2 = 398_600.4418;
const ORBIT_RADIUS_KM = 6_778.137;
const SHIP_MASS_KG = 10_000;

function earthCatalog() {
  return compileRailsCatalog([
    { id: 'earth', parentId: null, muKm3S2: EARTH_MU_KM3_S2, elements: null },
  ]);
}

function circularState(): Float64Array {
  const speedKmS = Math.sqrt(EARTH_MU_KM3_S2 / ORBIT_RADIUS_KM);
  const gamma = 1 / Math.sqrt(1 - (speedKmS / SPEED_OF_LIGHT_KM_S) ** 2);
  return new Float64Array([ORBIT_RADIUS_KM, 0, 0, 0, gamma * speedKmS, 0, 0]);
}

function farFieldState(): Float64Array {
  return new Float64Array([1e12, 0, 0, 0, 1, 0, 0]);
}

function verificationTolerance(maxAcceptedSteps = 4_000): Dp54Tolerance {
  return {
    absolute: new Float64Array([2e-8, 2e-8, 2e-8, 2e-11, 2e-11, 2e-11, 1e-6]),
    relative: 2e-11,
    initialStepSec: 1,
    maxAcceptedSteps,
  };
}

function stubRendererConsume(snapshot: SimSnapshot): number {
  return (snapshot.bodyPositionsKm[0] as number) + (snapshot.shipState[0] as number);
}

describe('SimulationCore', () => {
  it('publishes a render-consumable initial snapshot and exactly two frame buffers', () => {
    const core = new SimulationCore({
      catalog: earthCatalog(),
      initialShipState: circularState(),
      shipMassKg: SHIP_MASS_KG,
    });
    const initial = core.snapshot;

    expect(stubRendererConsume(initial)).toBe(ORBIT_RADIUS_KM);
    expect(initial.simTimeSec).toBe(0);
    expect(initial.shipProperTimeSec).toBe(0);
    expect(initial.gamma).toBeGreaterThan(1);

    const first = core.step(1);
    const firstX = first.shipState[0] as number;
    expect(first).not.toBe(initial);
    expect(first.shipState).not.toBe(initial.shipState);
    expect(initial.simTimeSec).toBe(0);
    expect(initial.shipState[0]).toBe(ORBIT_RADIUS_KM);

    const second = core.step(1);
    expect(second).toBe(initial);
    expect(first.simTimeSec).toBe(1);
    expect(first.shipState[0]).toBe(firstX);

    const third = core.step(1);
    expect(third).toBe(first);
    expect(core.snapshot).toBe(third);
  });

  it('publishes proper acceleration, thrust, and photon-drive power', () => {
    const core = new SimulationCore({
      catalog: earthCatalog(),
      initialShipState: circularState(),
      shipMassKg: SHIP_MASS_KG,
    });

    core.commands.setThrottle(0.6);
    core.commands.setAttitudeMode('prograde');
    core.commands.setWarp(5);
    core.commands.setTarget('earth');
    const snapshot = core.step(2);

    expect(snapshot.simTimeSec).toBe(10);
    expect(snapshot.requestedWarp).toBe(5);
    expect(snapshot.effectiveWarp).toBe(5);
    expect(snapshot.throttle).toBe(0.6);
    expect(snapshot.attitudeMode).toBe('prograde');
    expect(snapshot.targetBodyIndex).toBe(0);
    const expectedAccelerationKmS2 = (0.6 * DEFAULT_MAX_PROPER_ACCELERATION_M_S2) / 1_000;
    expect(Math.hypot(...snapshot.shipProperAccelerationKmS2)).toBeCloseTo(
      expectedAccelerationKmS2,
      14,
    );
    const expectedForceN = SHIP_MASS_KG * expectedAccelerationKmS2 * 1_000;
    expect(Math.hypot(...snapshot.shipThrustVectorN)).toBeCloseTo(expectedForceN, 9);
    expect(snapshot.powerDrawW).toBeCloseTo(expectedForceN * SPEED_OF_LIGHT_KM_S * 1_000, 0);
    expect(snapshot.shipState[4] as number).toBeGreaterThan(circularState()[4] as number);
    expect(snapshot.energySpentJ).toBeCloseTo(snapshot.powerDrawW * 10, 0);
    expect(snapshot.properDeltaVMS).toBeGreaterThan(0);
  });

  it('keeps prograde hold tangent while the ship advances through its orbit', () => {
    const core = new SimulationCore({
      catalog: earthCatalog(),
      initialShipState: circularState(),
      shipMassKg: SHIP_MASS_KG,
      integrationTolerance: verificationTolerance(),
    });
    core.commands.setAttitudeMode('prograde');
    const periodSec = 2 * Math.PI * Math.sqrt(ORBIT_RADIUS_KM ** 3 / EARTH_MU_KM3_S2);

    const snapshot = core.step(periodSec / 4);
    const forward = new Float64Array(3);
    writeForwardFromQuaternionInto(forward, snapshot.attitudeQuaternion);
    const speed = Math.hypot(...snapshot.shipCoordinateVelocityKmS);
    const alignment =
      ((forward[0] as number) * (snapshot.shipCoordinateVelocityKmS[0] as number) +
        (forward[1] as number) * (snapshot.shipCoordinateVelocityKmS[1] as number) +
        (forward[2] as number) * (snapshot.shipCoordinateVelocityKmS[2] as number)) /
      speed;

    expect(alignment).toBeGreaterThan(1 - 1e-12);
  });

  it('evaluates manual yaw rates exactly and commits only successful attitude', () => {
    const core = new SimulationCore({
      catalog: earthCatalog(),
      initialShipState: circularState(),
      shipMassKg: SHIP_MASS_KG,
    });
    core.commands.rotate(0, Math.PI / 2, 0);

    const snapshot = core.step(1);
    const forward = new Float64Array(3);
    writeForwardFromQuaternionInto(forward, snapshot.attitudeQuaternion);
    expect(forward[0]).toBeCloseTo(0, 13);
    expect(forward[1]).toBeCloseTo(1, 13);
    expect(forward[2]).toBeCloseTo(0, 13);
  });

  it('forwards thrust-command invalidation without duplicate events', () => {
    let invalidations = 0;
    const core = new SimulationCore({
      catalog: earthCatalog(),
      initialShipState: circularState(),
      shipMassKg: SHIP_MASS_KG,
      onTrajectoryInvalidated: () => {
        invalidations += 1;
      },
    });

    core.commands.setThrottle(0.4);
    core.commands.setThrottle(0.4);
    core.commands.setAttitudeMode('prograde');
    expect(invalidations).toBe(2);
  });

  it('does not let a mutated published ship array alter private physical state', () => {
    const core = new SimulationCore({
      catalog: earthCatalog(),
      initialShipState: circularState(),
      shipMassKg: SHIP_MASS_KG,
    });
    const published = core.snapshot;

    published.shipState[0] = ORBIT_RADIUS_KM * 2;
    published.shipState[4] = 0;
    const next = core.step(0);

    expect(next.shipState[0]).toBe(ORBIT_RADIUS_KM);
    expect(next.shipState[4]).not.toBe(0);
  });

  it('preserves a zero-thrust two-body orbit for ten periods within spec tolerance', () => {
    const periodSec = 2 * Math.PI * Math.sqrt(ORBIT_RADIUS_KM ** 3 / EARTH_MU_KM3_S2);
    const core = new SimulationCore({
      catalog: earthCatalog(),
      initialShipState: circularState(),
      shipMassKg: SHIP_MASS_KG,
      integrationTolerance: verificationTolerance(),
    });

    const snapshot = core.step(10 * periodSec);
    const separationKm = Math.hypot(
      (snapshot.shipState[0] as number) - ORBIT_RADIUS_KM,
      snapshot.shipState[1] as number,
      snapshot.shipState[2] as number,
    );

    expect(snapshot.simTimeSec).toBe(10 * periodSec);
    expect(separationKm).toBeLessThan(1e-3);
  });

  it('rejects invalid deltas and never publishes a failed propagation buffer', () => {
    const core = new SimulationCore({
      catalog: earthCatalog(),
      initialShipState: circularState(),
      shipMassKg: SHIP_MASS_KG,
      integrationTolerance: verificationTolerance(0),
    });
    const initial = core.snapshot;
    core.commands.rotate(0, Math.PI / 2, 0);

    expect(() => core.step(-1)).toThrow(/wall delta/u);
    expect(() => core.step(Number.NaN)).toThrow(/wall delta/u);
    expect(() => core.step(1)).toThrow(/integration budget/u);
    expect(core.snapshot).toBe(initial);
    expect(core.snapshot.simTimeSec).toBe(0);
    expect(core.snapshot.shipState[0]).toBe(ORBIT_RADIUS_KM);
    expect(core.snapshot.attitudeQuaternion).toEqual(new Float64Array([0, 0, 0, 1]));
  });

  it('clamps requested 1e7x in LEO to a canonical tier within the 4000-step budget', () => {
    const core = new SimulationCore({
      catalog: earthCatalog(),
      initialShipState: circularState(),
      shipMassKg: SHIP_MASS_KG,
    });
    core.commands.setWarp(1e7);

    const snapshot = core.step(1);

    expect(snapshot.requestedWarp).toBe(1e7);
    expect(snapshot.effectiveWarp).toBeLessThan(1e7);
    expect(WARP_LADDER).toContain(snapshot.effectiveWarp);
    expect(snapshot.simTimeSec).toBe(snapshot.effectiveWarp);
    expect(snapshot.warpClampReason).toBe(WarpClampReason.INTEGRATION_BUDGET);
  });

  it('sustains requested 1e7x in deep space and exposes coast-only thrust lockout', () => {
    const core = new SimulationCore({
      catalog: earthCatalog(),
      initialShipState: farFieldState(),
      shipMassKg: SHIP_MASS_KG,
    });
    core.commands.setThrottle(0.5);
    core.commands.setWarp(1e7);

    const snapshot = core.step(1);

    expect(snapshot.simTimeSec).toBe(1e7);
    expect(snapshot.requestedWarp).toBe(1e7);
    expect(snapshot.effectiveWarp).toBe(1e7);
    expect(snapshot.warpClampReason).toBe(WarpClampReason.THRUST_LOCKOUT);
    expect(snapshot.throttle).toBe(0);
    expect(snapshot.powerDrawW).toBe(0);
    expect(snapshot.shipProperAccelerationKmS2).toEqual(new Float64Array(3));
    expect(core.burnLog.activeBurn).toBeNull();
    expect(core.burnLog.count).toBe(0);
  });

  it('publishes the highest completed checkpoint when the shared budget is exhausted', () => {
    const core = new SimulationCore({
      catalog: earthCatalog(),
      initialShipState: farFieldState(),
      shipMassKg: SHIP_MASS_KG,
      integrationTolerance: verificationTolerance(2),
    });
    core.commands.setThrottle(0.4);
    core.commands.setWarp(10);

    const snapshot = core.step(1);

    expect(snapshot.requestedWarp).toBe(10);
    expect(snapshot.effectiveWarp).toBe(5);
    expect(snapshot.simTimeSec).toBe(5);
    expect(snapshot.warpClampReason).toBe(WarpClampReason.INTEGRATION_BUDGET);
    expect(snapshot.energySpentJ).toBeCloseTo(snapshot.powerDrawW * 5, 0);
    expect(snapshot.properDeltaVMS).toBeGreaterThan(0);
  });

  it('keeps equivalent physical horizons stable across warp changes', () => {
    const warped = new SimulationCore({
      catalog: earthCatalog(),
      initialShipState: circularState(),
      shipMassKg: SHIP_MASS_KG,
      integrationTolerance: verificationTolerance(),
    });
    const realtime = new SimulationCore({
      catalog: earthCatalog(),
      initialShipState: circularState(),
      shipMassKg: SHIP_MASS_KG,
      integrationTolerance: verificationTolerance(),
    });
    warped.commands.setThrottle(0.2);
    warped.commands.setAttitudeMode('prograde');
    warped.commands.setWarp(100);
    realtime.commands.setThrottle(0.2);
    realtime.commands.setAttitudeMode('prograde');

    const warpedSnapshot = warped.step(0.1);
    const realtimeSnapshot = realtime.step(10);

    expect(warpedSnapshot.simTimeSec).toBe(realtimeSnapshot.simTimeSec);
    expect(warpedSnapshot.shipProperTimeSec).toBeCloseTo(realtimeSnapshot.shipProperTimeSec, 8);
    for (let index = 0; index < warpedSnapshot.shipState.length; index += 1) {
      expect(warpedSnapshot.shipState[index]).toBeCloseTo(
        realtimeSnapshot.shipState[index] as number,
        7,
      );
    }
  });
});
