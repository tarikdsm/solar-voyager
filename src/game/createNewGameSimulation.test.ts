import bodiesDocument from '../../data/bodies.json';
import { describe, expect, it, vi } from 'vitest';

import {
  createGameSimulationFromPersistentState,
  createNewGameSimulation,
} from './createNewGameSimulation.js';

describe('createNewGameSimulation', () => {
  it('inherits Earth barycentric velocity in the committed 400 km LEO', () => {
    const core = createNewGameSimulation(10_000);
    const snapshot = core.snapshot;
    const earthIndex = snapshot.bodyIds.indexOf('earth');
    const earth = bodiesDocument.bodies[earthIndex];
    if (earth === undefined) throw new Error('Earth fixture is missing');
    const offset = earthIndex * 3;

    const earthRelativeX =
      (snapshot.bodyVelocitiesKmS[offset] as number) -
      (snapshot.barycenterVelocityKmS[0] as number);
    const earthRelativeY =
      (snapshot.bodyVelocitiesKmS[offset + 1] as number) -
      (snapshot.barycenterVelocityKmS[1] as number);
    const earthRelativeZ =
      (snapshot.bodyVelocitiesKmS[offset + 2] as number) -
      (snapshot.barycenterVelocityKmS[2] as number);
    const inheritedEarthSpeedKmS = Math.hypot(earthRelativeX, earthRelativeY, earthRelativeZ);
    expect(inheritedEarthSpeedKmS).toBeGreaterThan(29);
    expect(inheritedEarthSpeedKmS).toBeLessThan(31);

    const localVx = (snapshot.shipCmRelativeVelocityKmS[0] as number) - earthRelativeX;
    const localVy = (snapshot.shipCmRelativeVelocityKmS[1] as number) - earthRelativeY;
    const localVz = (snapshot.shipCmRelativeVelocityKmS[2] as number) - earthRelativeZ;
    const expectedCircularSpeedKmS = Math.sqrt(earth.muKm3S2 / (earth.meanRadiusKm + 400));
    expect(Math.hypot(localVx, localVy, localVz)).toBeCloseTo(expectedCircularSpeedKmS, 10);

    const dx = (snapshot.shipState[0] as number) - (snapshot.bodyPositionsKm[offset] as number);
    const dy = (snapshot.shipState[1] as number) - (snapshot.bodyPositionsKm[offset + 1] as number);
    const dz = (snapshot.shipState[2] as number) - (snapshot.bodyPositionsKm[offset + 2] as number);
    const expectedOrbitRadiusKm = earth.meanRadiusKm + 400;
    expect(Math.hypot(dx, dy, dz)).toBeCloseTo(expectedOrbitRadiusKm, 6);
    expect(snapshot.bodyIds[snapshot.dominantBodyIndex]).toBe('earth');
    expect(snapshot.osculatingElements.valid).toBe(true);
    expect(snapshot.osculatingElements.semiMajorAxisKm).toBeCloseTo(expectedOrbitRadiusKm, 6);
    expect(snapshot.osculatingElements.eccentricity).toBeCloseTo(0, 11);
    expect(snapshot.osculatingElements.periapsisRadiusKm).toBeCloseTo(expectedOrbitRadiusKm, 6);
    expect(snapshot.osculatingElements.apoapsisRadiusKm).toBeCloseTo(expectedOrbitRadiusKm, 6);
    expect(snapshot.osculatingElements.periodSec).toBeCloseTo(
      2 * Math.PI * Math.sqrt(expectedOrbitRadiusKm ** 3 / earth.muKm3S2),
      6,
    );
    expect(core.step(1).simTimeSec).toBe(1);
  });

  it('preserves trajectory invalidation listeners across new and restored simulations', () => {
    const newGameInvalidated = vi.fn();
    const core = createNewGameSimulation(10_000, newGameInvalidated);

    core.commands.setThrottle(0.25);

    expect(newGameInvalidated).toHaveBeenCalledOnce();
    const restoredInvalidated = vi.fn();
    const restored = createGameSimulationFromPersistentState(
      10_000,
      core.exportPersistentState(),
      restoredInvalidated,
    );
    restored.commands.setThrottle(0);
    expect(restoredInvalidated).toHaveBeenCalledOnce();
  });
});
