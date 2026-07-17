import { effect } from '@preact/signals';
import { describe, expect, it } from 'vitest';

import { createSimulationSnapshotBuffer } from '../sim/simulationSnapshot.js';
import {
  createHudSignalStore,
  formatDurationSec,
  formatOrbitDistanceKm,
  formatUtcTimeMs,
} from './hudSignals.js';

function populatedSnapshot() {
  const snapshot = createSimulationSnapshotBuffer(Object.freeze(['sun', 'earth']));
  snapshot.utcTimeMs = Date.UTC(2026, 0, 2, 3, 4, 5, 678);
  snapshot.shipProperTimeSec = 90_061.25;
  snapshot.gamma = 1.25;
  snapshot.dominantBodyIndex = 1;
  snapshot.osculatingElements.valid = true;
  snapshot.osculatingElements.apoapsisRadiusKm = 42_164;
  snapshot.osculatingElements.periapsisRadiusKm = 6_778.137;
  snapshot.osculatingElements.eccentricity = 0.731_234_567;
  snapshot.osculatingElements.inclinationRad = Math.PI / 6;
  snapshot.osculatingElements.periodSec = 86_164.1;
  return snapshot;
}

describe('HUD signal store', () => {
  it('copies exact simulation scalars and derives presentation at leaf signals', () => {
    const snapshot = populatedSnapshot();
    const store = createHudSignalStore();

    expect(store.publish(snapshot, 0)).toBe(true);
    expect(store.signals.dominantBodyId.value).toBe('earth');
    expect(store.signals.apoapsisRadiusKm.value).toBe(42_164);
    expect(store.signals.periapsisRadiusKm.value).toBe(6_778.137);
    expect(store.signals.eccentricity.value).toBe(0.731_234_567);
    expect(store.signals.inclinationRad.value).toBe(Math.PI / 6);
    expect(store.signals.periodSec.value).toBe(86_164.1);
    expect(store.signals.utcTimeMs.value).toBe(snapshot.utcTimeMs);
    expect(store.signals.shipProperTimeSec.value).toBe(90_061.25);
    expect(store.signals.gamma.value).toBe(1.25);

    expect(store.display.dominantBody.value).toBe('Earth');
    expect(store.display.apoapsis.value).toBe('42,164 km');
    expect(store.display.periapsis.value).toBe('6,778.14 km');
    expect(store.display.eccentricity.value).toBe('0.731235');
    expect(store.display.inclination.value).toBe('30.000°');
    expect(store.display.period.value).toBe('23:56:04.100');
    expect(store.display.coordinateUtc.value).toBe('2026-01-02 03:04:05.678 UTC');
    expect(store.display.missionElapsedTime.value).toBe('1d 01:01:01.250');
    expect(store.display.gamma.value).toBe('γ 1.250000');
  });

  it('samples at 10 Hz and only notifies observers whose scalar changed', () => {
    const snapshot = populatedSnapshot();
    const store = createHudSignalStore();
    store.publish(snapshot, 1_000);
    let apoapsisObserverRuns = 0;
    const dispose = effect(() => {
      void store.signals.apoapsisRadiusKm.value;
      apoapsisObserverRuns += 1;
    });

    snapshot.utcTimeMs += 50;
    expect(store.publish(snapshot, 1_050)).toBe(false);
    expect(store.signals.utcTimeMs.value).toBe(Date.UTC(2026, 0, 2, 3, 4, 5, 678));

    expect(store.publish(snapshot, 1_100)).toBe(true);
    expect(store.signals.utcTimeMs.value).toBe(Date.UTC(2026, 0, 2, 3, 4, 5, 728));
    expect(apoapsisObserverRuns).toBe(1);
    dispose();
  });

  it('renders invalid and open osculating solutions explicitly', () => {
    const snapshot = populatedSnapshot();
    const store = createHudSignalStore();
    snapshot.osculatingElements.valid = false;
    snapshot.osculatingElements.apoapsisRadiusKm = Number.NaN;
    snapshot.osculatingElements.periodSec = Number.NaN;
    snapshot.gamma = 1.001;
    store.publish(snapshot, 0);

    expect(store.display.apoapsis.value).toBe('—');
    expect(store.display.period.value).toBe('—');
    expect(store.display.gamma.value).toBe('');

    snapshot.osculatingElements.valid = true;
    snapshot.osculatingElements.apoapsisRadiusKm = Number.POSITIVE_INFINITY;
    snapshot.osculatingElements.periodSec = Number.POSITIVE_INFINITY;
    snapshot.gamma = 1.001_001;
    store.publish(snapshot, 100);

    expect(store.display.apoapsis.value).toBe('∞');
    expect(store.display.period.value).toBe('∞');
    expect(store.display.gamma.value).toBe('γ 1.001001');
  });
});

describe('HUD formatters', () => {
  it('uses deterministic compact distance, duration, and UTC forms', () => {
    expect(formatOrbitDistanceKm(0.125)).toBe('0.125 km');
    expect(formatOrbitDistanceKm(12_345_678)).toBe('12.3457 Mkm');
    expect(formatDurationSec(65.004)).toBe('00:01:05.004');
    expect(formatDurationSec(172_800)).toBe('2d 00:00:00.000');
    expect(formatUtcTimeMs(Date.UTC(2026, 6, 17, 12, 30, 45, 6))).toBe(
      '2026-07-17 12:30:45.006 UTC',
    );
  });
});
