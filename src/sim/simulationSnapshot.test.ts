import { describe, expect, it } from 'vitest';

import { WARP_LADDER, type WarpFactor } from '../core/time.js';
import {
  createCommandController,
  createSimulationSnapshotBuffer,
  WarpClampReason,
  WarningFlag,
} from './simulationSnapshot.js';

describe('simulation snapshot storage', () => {
  it('allocates one complete neutral frame with stable typed-array dimensions', () => {
    const bodyIds = Object.freeze(['sun', 'earth']);
    const snapshot = createSimulationSnapshotBuffer(bodyIds);

    expect(snapshot.bodyIds).toBe(bodyIds);
    expect(snapshot.bodyPositionsKm).toHaveLength(6);
    expect(snapshot.bodyVelocitiesKmS).toHaveLength(6);
    expect(snapshot.shipState).toHaveLength(7);
    expect(snapshot.attitudeQuaternion).toEqual(new Float64Array([0, 0, 0, 1]));
    expect(snapshot.shipCoordinateVelocityKmS).toHaveLength(3);
    expect(snapshot.shipCmRelativeVelocityKmS).toHaveLength(3);
    expect(snapshot.shipProperAccelerationKmS2).toHaveLength(3);
    expect(snapshot.shipThrustVectorN).toHaveLength(3);
    expect(snapshot.shipRelativisticMomentumKgKmS).toHaveLength(3);
    expect(snapshot.shipAngularMomentumKgKm2S).toHaveLength(3);
    expect(snapshot.barycenterPositionKm).toHaveLength(3);
    expect(snapshot.barycenterVelocityKmS).toHaveLength(3);
    expect(snapshot.requestedWarp).toBe(1);
    expect(snapshot.effectiveWarp).toBe(1);
    expect(snapshot.warpClampReason).toBe(WarpClampReason.NONE);
    expect(snapshot.dominantBodyIndex).toBe(-1);
    expect(snapshot.osculatingElements.valid).toBe(false);
    expect(snapshot.warningFlags).toBe(WarningFlag.NONE);
    expect(snapshot.energySpentJ).toBe(0);
    expect(snapshot.properDeltaVMS).toBe(0);
    expect(snapshot.powerDrawW).toBe(0);
  });
});

describe('command controller', () => {
  it('retains validated intent in one preallocated state object', () => {
    const controller = createCommandController(Object.freeze(['sun', 'earth']));
    const stateIdentity = controller.state;

    controller.commands.setThrottle(0.75);
    controller.commands.setAttitudeMode('prograde');
    controller.commands.rotate(0.1, -0.2, 0.3);
    controller.commands.setWarp(WARP_LADDER[4]);
    controller.commands.setTarget('earth');

    expect(controller.state).toBe(stateIdentity);
    expect(controller.state.throttle).toBe(0.75);
    expect(controller.state.attitudeMode).toBe('prograde');
    expect(Array.from(controller.state.rotationRatesRadS)).toEqual([0.1, -0.2, 0.3]);
    expect(controller.state.requestedWarp).toBe(100);
    expect(controller.state.targetBodyIndex).toBe(1);
    expect(controller.state.targetBodyId).toBe('earth');

    controller.commands.setTarget(null);
    expect(controller.state.targetBodyIndex).toBe(-1);
    expect(controller.state.targetBodyId).toBeNull();
  });

  it('rejects invalid player intent without changing the previous state', () => {
    const controller = createCommandController(Object.freeze(['sun', 'earth']));
    controller.commands.setThrottle(0.25);
    controller.commands.setWarp(10);

    expect(() => controller.commands.setThrottle(1.01)).toThrow(/throttle/u);
    expect(() => controller.commands.rotate(Number.NaN, 0, 0)).toThrow(/rotation rates/u);
    expect(() => controller.commands.setWarp(2 as WarpFactor)).toThrow(/warp/u);
    expect(() => controller.commands.setTarget('mars')).toThrow(/target body/u);
    expect(controller.state.throttle).toBe(0.25);
    expect(controller.state.requestedWarp).toBe(10);
    expect(controller.state.targetBodyIndex).toBe(-1);
  });
});
