import { describe, expect, it } from 'vitest';

import { SPEED_OF_LIGHT_KM_S } from '../core/constants.js';
import type { Dp54Tolerance } from './propagation/dp54.js';
import { compileRailsCatalog } from './propagation/rails.js';
import { SimulationCore } from './simulation.js';
import type { SimSnapshot } from './simulationSnapshot.js';

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

  it('stores command intent while zero thrust leaves propulsion fields neutral', () => {
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
    expect(snapshot.shipProperAccelerationKmS2).toEqual(new Float64Array(3));
    expect(snapshot.shipThrustVectorN).toEqual(new Float64Array(3));
    expect(snapshot.powerDrawW).toBe(0);
    expect(snapshot.energySpentJ).toBe(0);
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

    expect(() => core.step(-1)).toThrow(/wall delta/u);
    expect(() => core.step(Number.NaN)).toThrow(/wall delta/u);
    expect(() => core.step(1)).toThrow(/integration budget/u);
    expect(core.snapshot).toBe(initial);
    expect(core.snapshot.simTimeSec).toBe(0);
    expect(core.snapshot.shipState[0]).toBe(ORBIT_RADIUS_KM);
  });
});
