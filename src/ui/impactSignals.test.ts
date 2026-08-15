import { describe, expect, it } from 'vitest';

import { createSimulationSnapshotBuffer } from '../sim/simulationSnapshot.js';
import { createImpactSignalStore } from './impactSignals.js';

function snapshotBuffer() {
  return createSimulationSnapshotBuffer(['earth', 'moon']);
}

describe('impact signals - ADR-036', () => {
  it('stays hidden and reports nothing before contact', () => {
    const store = createImpactSignalStore();
    const snapshot = snapshotBuffer();

    expect(store.publish(snapshot, 0)).toBe(false);
    expect(store.display.visible.value).toBe(false);
    expect(store.display.restoreEnabled.value).toBe(false);
    expect(store.display.restoreLabel.value).toBe('No checkpoint available');
  });

  it('publishes body, speed and both clocks on contact', () => {
    const store = createImpactSignalStore();
    const snapshot = snapshotBuffer();
    snapshot.impactOccurred = 1;
    snapshot.impactBodyIndex = 1;
    snapshot.impactSpeedKmS = 2.5;
    snapshot.impactSimTimeSec = 1_234.5;
    snapshot.shipProperTimeSec = 1_234;
    snapshot.utcTimeMs = Date.UTC(2026, 0, 1);

    expect(store.publish(snapshot, 3)).toBe(true);
    expect(store.display.visible.value).toBe(true);
    expect(store.display.body.value).toBe('Moon');
    expect(store.display.speed.value).toBe('2.5 km/s');
    expect(store.display.missionElapsedTime.value).toBe('00:20:34.000');
    expect(store.display.coordinateUtc.value).toMatch(/UTC$/u);
    expect(store.display.restoreEnabled.value).toBe(true);
    expect(store.display.restoreLabel.value).toBe('Restore last checkpoint');
  });

  it('uses m/s below one km per second so a slow touchdown still reads', () => {
    const store = createImpactSignalStore();
    const snapshot = snapshotBuffer();
    snapshot.impactOccurred = 1;
    snapshot.impactBodyIndex = 0;
    snapshot.impactSpeedKmS = 0.0421;
    store.publish(snapshot, 1);

    expect(store.display.speed.value).toBe('42.1 m/s');
  });

  it('short-circuits the frames where nothing about the overlay changed', () => {
    const store = createImpactSignalStore();
    const snapshot = snapshotBuffer();

    expect(store.publish(snapshot, 0)).toBe(false);
    expect(store.publish(snapshot, 2)).toBe(true);
    expect(store.publish(snapshot, 2)).toBe(false);

    snapshot.impactOccurred = 1;
    snapshot.impactBodyIndex = 0;
    snapshot.impactSimTimeSec = 10;
    expect(store.publish(snapshot, 2)).toBe(true);
    expect(store.publish(snapshot, 2)).toBe(false);
  });

  it('clears back to hidden when a recovery replaces the core', () => {
    const store = createImpactSignalStore();
    const impacted = snapshotBuffer();
    impacted.impactOccurred = 1;
    impacted.impactBodyIndex = 0;
    store.publish(impacted, 1);
    expect(store.display.visible.value).toBe(true);

    store.publish(snapshotBuffer(), 0);

    expect(store.display.visible.value).toBe(false);
    expect(store.display.body.value).toBe('—');
  });

  it('renders an unknown body index as the empty placeholder', () => {
    const store = createImpactSignalStore();
    const snapshot = snapshotBuffer();
    snapshot.impactOccurred = 1;
    snapshot.impactBodyIndex = 99;
    store.publish(snapshot, 1);

    expect(store.display.visible.value).toBe(true);
    expect(store.display.body.value).toBe('—');
  });
});
