import { describe, expect, it } from 'vitest';

import { createSimulationSnapshotBuffer } from '../sim/simulationSnapshot.js';
import { createStateVectorSignalStore } from './stateVectorSignals.js';

function createSnapshot() {
  const snapshot = createSimulationSnapshotBuffer(['sun', 'earth']);
  snapshot.shipCmRelativeVelocityKmS.set([29.78, 0, 0]);
  snapshot.shipProperAccelerationKmS2.set([0, 0.009_806_65, 0]);
  snapshot.shipRelativisticMomentumKgKmS.set([297_800, 0, 0]);
  snapshot.shipAngularMomentumKgKm2S.set([0, 0, 4.47e16]);
  snapshot.gamma = 1.000_000_004_94;
  snapshot.speedFractionOfLight = 29.78 / 299_792.458;
  return snapshot;
}

describe('state-vector sampled signals', () => {
  it('publishes all CM-relative readouts with SI prefixes', () => {
    const store = createStateVectorSignalStore();

    expect(store.publish(createSnapshot(), 0)).toBe(true);

    expect(store.display.velocity.value).toBe('29.8 km/s');
    expect(store.display.acceleration.value).toBe('9.81 m/s²');
    expect(store.display.momentum.value).toBe('298 MN·s');
    expect(store.display.angularMomentum.value).toBe('44.7 Zkg·m²/s');
    expect(store.display.gamma.value).toBe('γ 1.000000');
    expect(store.display.speedFraction.value).toBe('0.00993% c');
  });

  it('samples numeric values at 10 Hz while orientation changes immediately', () => {
    const store = createStateVectorSignalStore();
    const snapshot = createSnapshot();
    store.publish(snapshot, 0);
    snapshot.shipCmRelativeVelocityKmS.set([60, 0, 0]);

    expect(store.publish(snapshot, 99)).toBe(false);
    expect(store.display.velocity.value).toBe('29.8 km/s');
    expect(store.publish(snapshot, 100)).toBe(true);
    expect(store.display.velocity.value).toBe('60 km/s');

    store.setPinnedToEcliptic(true);
    expect(store.signals.pinnedToEcliptic.value).toBe(true);
    store.setPinnedToEcliptic(false);
    expect(store.signals.pinnedToEcliptic.value).toBe(false);
  });

  it('rejects invalid sample times and displays invalid vectors as unavailable', () => {
    const store = createStateVectorSignalStore();
    const snapshot = createSnapshot();
    snapshot.shipCmRelativeVelocityKmS[0] = Number.NaN;

    expect(() => store.publish(snapshot, Number.NaN)).toThrow(RangeError);
    expect(store.publish(snapshot, 0)).toBe(true);
    expect(store.display.velocity.value).toBe('—');
  });
});
