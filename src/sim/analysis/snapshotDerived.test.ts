import { describe, expect, it } from 'vitest';

import { SPEED_OF_LIGHT_KM_S } from '../../core/constants.js';
import { createSimulationSnapshotBuffer } from '../simulationSnapshot.js';
import { updateSnapshotDerivedState } from './snapshotDerived.js';

describe('updateSnapshotDerivedState', () => {
  it('writes relativistic CM-relative velocity, momentum, and angular momentum', () => {
    const snapshot = createSimulationSnapshotBuffer(Object.freeze(['primary']));
    const gamma = 2;
    const velocityXKmS = (Math.sqrt(3) / 2) * SPEED_OF_LIGHT_KM_S;
    snapshot.shipState.set([11, 23, 37, gamma * velocityXKmS, 0, 0, 41]);
    snapshot.barycenterPositionKm.set([1, 3, 7]);
    snapshot.barycenterVelocityKmS.set([5, 11, 13]);

    updateSnapshotDerivedState(snapshot, 7);

    expect(snapshot.shipProperTimeSec).toBe(41);
    expect(snapshot.gamma).toBeCloseTo(gamma, 14);
    expect(snapshot.speedFractionOfLight).toBeCloseTo(Math.sqrt(3) / 2, 14);
    expect(snapshot.shipCoordinateVelocityKmS[0]).toBeCloseTo(velocityXKmS, 10);
    expect(Array.from(snapshot.shipCmRelativeVelocityKmS)).toEqual([
      (snapshot.shipCoordinateVelocityKmS[0] as number) - 5,
      -11,
      -13,
    ]);

    const px = gamma * 7 * ((snapshot.shipCoordinateVelocityKmS[0] as number) - 5);
    const py = gamma * 7 * -11;
    const pz = gamma * 7 * -13;
    expect(snapshot.shipRelativisticMomentumKgKmS[0]).toBeCloseTo(px, 9);
    expect(snapshot.shipRelativisticMomentumKgKmS[1]).toBe(py);
    expect(snapshot.shipRelativisticMomentumKgKmS[2]).toBe(pz);

    const rx = 10;
    const ry = 20;
    const rz = 30;
    expect(snapshot.shipAngularMomentumKgKm2S[0]).toBeCloseTo(ry * pz - rz * py, 9);
    expect(snapshot.shipAngularMomentumKgKm2S[1]).toBeCloseTo(rz * px - rx * pz, 9);
    expect(snapshot.shipAngularMomentumKgKm2S[2]).toBeCloseTo(rx * py - ry * px, 9);
  });
});
