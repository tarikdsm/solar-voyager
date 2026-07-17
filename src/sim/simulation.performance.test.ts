import { describe, expect, it } from 'vitest';

import { SPEED_OF_LIGHT_KM_S } from '../core/constants.js';
import { compileRailsCatalog } from './propagation/rails.js';
import { SimulationCore } from './simulation.js';

function createCore(): SimulationCore {
  const muKm3S2 = 398_600.4418;
  const radiusKm = 6_778.137;
  const velocityKmS = Math.sqrt(muKm3S2 / radiusKm);
  const gamma = 1 / Math.sqrt(1 - (velocityKmS / SPEED_OF_LIGHT_KM_S) ** 2);
  return new SimulationCore({
    catalog: compileRailsCatalog([{ id: 'earth', parentId: null, muKm3S2, elements: null }]),
    initialShipState: new Float64Array([radiusKm, 0, 0, 0, gamma * velocityKmS, 0, 0]),
    shipMassKg: 10_000,
  });
}

describe('SimulationCore frame storage', () => {
  it('reuses exactly two snapshots and every reachable frame array', () => {
    const core = createCore();
    core.commands.setAttitudeMode('prograde');
    core.commands.setThrottle(0.5);
    const first = core.snapshot;
    const second = core.step(1 / 60);
    const frameArrays = [
      first.bodyPositionsKm,
      first.bodyVelocitiesKmS,
      first.shipState,
      first.shipCoordinateVelocityKmS,
      first.shipCmRelativeVelocityKmS,
      first.shipProperAccelerationKmS2,
      first.shipThrustVectorN,
      first.shipRelativisticMomentumKgKmS,
      first.shipAngularMomentumKgKm2S,
      first.barycenterPositionKm,
      first.barycenterVelocityKmS,
      first.attitudeQuaternion,
      second.bodyPositionsKm,
      second.bodyVelocitiesKmS,
      second.shipState,
      second.shipCoordinateVelocityKmS,
      second.shipCmRelativeVelocityKmS,
      second.shipProperAccelerationKmS2,
      second.shipThrustVectorN,
      second.shipRelativisticMomentumKgKmS,
      second.shipAngularMomentumKgKm2S,
      second.barycenterPositionKm,
      second.barycenterVelocityKmS,
      second.attitudeQuaternion,
    ];

    for (let frame = 0; frame < 2_000; frame += 1) core.step(1 / 60);

    expect(core.snapshot === first || core.snapshot === second).toBe(true);
    expect(new Set(frameArrays).size).toBe(frameArrays.length);
    expect(core.step(1 / 60)).toBe(core.snapshot);
    expect(core.snapshot === first || core.snapshot === second).toBe(true);
  });
});
