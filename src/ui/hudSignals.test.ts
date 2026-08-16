import { effect } from '@preact/signals';
import { describe, expect, it } from 'vitest';

import { formatEnergyWh, formatPowerW } from '../core/formatUnits.js';
import { writeQuaternionFromForwardInto } from '../sim/ship/attitude.js';
import { createSimulationSnapshotBuffer, WarpClampReason } from '../sim/simulationSnapshot.js';
import {
  createHudSignalStore,
  formatDurationSec,
  formatOrbitDistanceKm,
  formatUtcTimeMs,
} from './hudSignals.js';
import { NavballMarkerIndex } from './navballProjection.js';

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

  it('publishes a clamp reason synchronously inside the next frame', () => {
    const snapshot = populatedSnapshot();
    const store = createHudSignalStore();
    store.publish(snapshot, 0);
    snapshot.requestedWarp = 1_000;
    snapshot.effectiveWarp = 100;
    snapshot.warpClampReason = WarpClampReason.INTEGRATION_BUDGET;

    expect(store.publish(snapshot, 16)).toBe(false);
    expect(store.signals.requestedWarp.value).toBe(1_000);
    expect(store.signals.effectiveWarp.value).toBe(100);
    expect(store.signals.warpClampReason.value).toBe(WarpClampReason.INTEGRATION_BUDGET);
    expect(store.display.requestedWarp.value).toBe('1,000×');
    expect(store.display.effectiveWarp.value).toBe('100×');
    expect(store.display.warpClamp.value).toBe(
      'Gravity well · integration budget · 100× sustainable',
    );
  });

  it('uses the shared energy formatters and exposes secondary ledger values', () => {
    const snapshot = populatedSnapshot();
    const store = createHudSignalStore();
    snapshot.energySpentJ = 4.82e15 * 3_600;
    snapshot.powerDrawW = 3.21e12;
    snapshot.properDeltaVMS = 1_234.5;
    snapshot.kineticEnergyChangeJ = -6.78e11;

    store.publish(snapshot, 0);

    expect(store.display.energySpent.value).toBe(formatEnergyWh(snapshot.energySpentJ));
    expect(store.display.energySpent.value).toBe('4.82 PWh');
    expect(store.display.powerDraw.value).toBe(formatPowerW(snapshot.powerDrawW));
    expect(store.display.powerDraw.value).toBe('3.21 TW');
    expect(store.display.properDeltaV.value).toBe('1.23 km/s');
    expect(store.display.kineticEnergyChange.value).toBe('-678 GJ');
  });

  it('shows the active or latest burn separately from session totals', () => {
    const snapshot = populatedSnapshot();
    const store = createHudSignalStore();
    store.publish(snapshot, 0);

    expect(store.display.burnSummaryLabel.value).toBe('No burns yet');
    expect(store.display.burnEnergy.value).toBe('—');
    expect(store.display.burnProperDeltaV.value).toBe('—');

    snapshot.burnSummaryAvailable = true;
    snapshot.burnSummaryActive = true;
    snapshot.burnEnergySpentJ = 3_600_000;
    snapshot.burnProperDeltaVMS = 12.3;
    store.publish(snapshot, 100);

    expect(store.display.burnSummaryLabel.value).toBe('Active burn');
    expect(store.display.burnEnergy.value).toBe('1.00 kWh');
    expect(store.display.burnProperDeltaV.value).toBe('12.3 m/s');

    snapshot.burnSummaryActive = false;
    store.publish(snapshot, 200);
    expect(store.display.burnSummaryLabel.value).toBe('Last burn');
  });

  it('promotes signed kinetic-energy values at rounded SI-prefix boundaries', () => {
    const snapshot = populatedSnapshot();
    const store = createHudSignalStore();
    snapshot.kineticEnergyChangeJ = 999.5;
    store.publish(snapshot, 0);
    expect(store.display.kineticEnergyChange.value).toBe('1.00 kJ');

    snapshot.kineticEnergyChangeJ = -999.5;
    store.publish(snapshot, 100);
    expect(store.display.kineticEnergyChange.value).toBe('-1.00 kJ');
  });

  it('derives selected-target distance and relative speed directly from snapshot arrays', () => {
    const snapshot = populatedSnapshot();
    const store = createHudSignalStore();
    snapshot.shipState.set([0, 0, 0]);
    snapshot.shipCoordinateVelocityKmS.set([4, 6, 3]);
    snapshot.bodyPositionsKm.set([100, 100, 100, 3, 4, 0]);
    snapshot.bodyVelocitiesKmS.set([0, 0, 0, 1, 2, 3]);
    snapshot.targetBodyIndex = 1;
    snapshot.targetBodyId = 'earth';

    store.publish(snapshot, 0);

    expect(store.signals.targetBodyId.value).toBe('earth');
    expect(store.signals.targetDistanceKm.value).toBe(5);
    expect(store.signals.targetRelativeSpeedKmS.value).toBe(5);
    expect(store.display.targetBody.value).toBe('Earth');
    expect(store.display.targetDistance.value).toBe('5 km');
    expect(store.display.targetRelativeSpeed.value).toBe('5 km/s');
    expect(store.display.nextClosestApproach.value).toBe('Awaiting trajectory predictor');
  });

  it('keeps coordinate and proper clocks visibly divergent above gamma 1.1', () => {
    const snapshot = populatedSnapshot();
    const store = createHudSignalStore();
    snapshot.utcTimeMs = Date.UTC(2026, 0, 1, 0, 0, 10);
    snapshot.shipProperTimeSec = 8;
    snapshot.gamma = 1.25;

    store.publish(snapshot, 0);

    expect(store.display.coordinateUtc.value).toBe('2026-01-01 00:00:10.000 UTC');
    expect(store.display.missionElapsedTime.value).toBe('00:00:08.000');
    expect(store.display.gamma.value).toBe('γ 1.250000');
  });

  it('samples the dominant-body navball frame and attitude label at 10 Hz', () => {
    const snapshot = populatedSnapshot();
    const store = createHudSignalStore();
    const earthOffset = 3;
    snapshot.bodyPositionsKm[earthOffset] = 0;
    snapshot.bodyPositionsKm[earthOffset + 1] = 0;
    snapshot.bodyPositionsKm[earthOffset + 2] = 0;
    snapshot.shipState.set([6_778.137, 0, 0]);
    snapshot.shipCoordinateVelocityKmS.set([0, 7.668_558, 0]);
    snapshot.shipProperAccelerationKmS2.set([0.009_806_65, 0, 0]);
    snapshot.attitudeMode = 'prograde';

    store.publish(snapshot, 0);

    const prograde = store.signals.navball.markers[NavballMarkerIndex.PROGRADE];
    const radialOut = store.signals.navball.markers[NavballMarkerIndex.RADIAL_OUT];
    expect(store.signals.navball.valid.value).toBe(true);
    expect(prograde?.x.value).toBeCloseTo(1, 12);
    expect(prograde?.y.value).toBeCloseTo(0, 12);
    expect(prograde?.visible.value).toBe(true);
    expect(radialOut?.x.value).toBeCloseTo(0, 12);
    expect(radialOut?.visible.value).toBe(true);
    expect(store.signals.navball.thrustVisible.value).toBe(true);
    expect(store.display.attitudeMode.value).toBe('Prograde hold');

    snapshot.attitudeMode = 'normal';
    writeQuaternionFromForwardInto(snapshot.attitudeQuaternion, 0, 1, 0);
    expect(store.publish(snapshot, 50)).toBe(false);
    expect(store.display.attitudeMode.value).toBe('Prograde hold');
    expect(prograde?.x.value).toBeCloseTo(1, 12);

    expect(store.publish(snapshot, 100)).toBe(true);
    expect(store.display.attitudeMode.value).toBe('Normal hold');
    expect(prograde?.x.value).toBeCloseTo(0, 12);
    expect(prograde?.visible.value).toBe(true);
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

describe('HUD flight strip and world markers - T0112', () => {
  const BODY_IDS = Object.freeze(['sun', 'earth']);
  const EARTH_RADIUS_KM = 6_371.0084;

  function flightSnapshot() {
    const snapshot = createSimulationSnapshotBuffer(BODY_IDS);
    snapshot.dominantBodyIndex = 1;
    snapshot.targetBodyIndex = 1;
    snapshot.throttle = 0.42;
    snapshot.bodyPositionsKm.set([0, 0, -1e8], 0);
    snapshot.bodyPositionsKm.set([0, 0, -10_000], 3);
    snapshot.shipState.set([0, 0, 0], 0);
    return snapshot;
  }

  const POSE = Object.freeze({
    positionKm: { x: 0, y: 0, z: 0 },
    lookDirection: { x: 0, y: 0, z: -1 },
    upDirection: { x: 0, y: 1, z: 0 },
    fovDeg: 90,
  });

  /** Radii in catalog order, injected so the store never reaches for a singleton. */
  const RADII_KM = Float64Array.from([696_340, EARTH_RADIUS_KM]);
  const NAMES = Object.freeze(['Sun', 'Earth']);

  it('picks the unit the speed deserves', () => {
    const snapshot = flightSnapshot();
    const store = createHudSignalStore(RADII_KM, NAMES);

    snapshot.shipCoordinateVelocityKmS.set([0.25, 0, 0], 0);
    store.publish(snapshot, 0);
    expect(store.display.relativeSpeed.value).toBe('250 m/s');

    // A decimal only where it carries information: docking speeds, not orbital ones.
    snapshot.shipCoordinateVelocityKmS.set([0.0125, 0, 0], 0);
    store.publish(snapshot, 500);
    expect(store.display.relativeSpeed.value).toBe('12.5 m/s');

    snapshot.shipCoordinateVelocityKmS.set([7.66, 0, 0], 0);
    store.publish(snapshot, 1_000);
    expect(store.display.relativeSpeed.value).toBe('7.66 km/s');

    // Past one percent of light, km/s is six digits of noise.
    snapshot.shipCoordinateVelocityKmS.set([149_896.229, 0, 0], 0);
    store.publish(snapshot, 2_000);
    expect(store.display.relativeSpeed.value).toBe('50.000 %c');
  });

  it('measures speed and radar altitude against the dominant body', () => {
    const snapshot = flightSnapshot();
    // Ship and Earth share a 30 km/s heliocentric velocity: relative speed zero.
    snapshot.shipCoordinateVelocityKmS.set([30, 0, 0], 0);
    snapshot.bodyVelocitiesKmS.set([30, 0, 0], 3);
    const store = createHudSignalStore(RADII_KM, NAMES);

    store.publish(snapshot, 0);

    expect(store.signals.relativeSpeedKmS.value).toBeCloseTo(0, 12);
    expect(store.signals.radarAltitudeKm.value).toBeCloseTo(10_000 - EARTH_RADIUS_KM, 6);
    expect(store.display.throttlePercent.value).toBe('42%');
  });

  it('reports no altitude without a dominant body or a known radius', () => {
    const snapshot = flightSnapshot();
    snapshot.dominantBodyIndex = -1;
    const store = createHudSignalStore(RADII_KM, NAMES);
    store.publish(snapshot, 0);
    expect(store.display.radarAltitude.value).toBe('—');

    const unknownRadii = createHudSignalStore(new Float64Array(2), NAMES);
    unknownRadii.publish(flightSnapshot(), 0);
    expect(unknownRadii.display.radarAltitude.value).toBe('—');
  });

  it('surfaces the impact freeze ahead of a warp clamp on one warning line', () => {
    const snapshot = flightSnapshot();
    const store = createHudSignalStore(RADII_KM, NAMES);
    store.publish(snapshot, 0);
    expect(store.display.flightWarning.value).toBe('');

    snapshot.warpClampReason = WarpClampReason.THRUST_LOCKOUT;
    store.publish(snapshot, 1_000);
    expect(store.display.flightWarning.value).toBe('Coast only · thrust locked above 1,000×');

    snapshot.impactOccurred = 1;
    store.publish(snapshot, 2_000);
    expect(store.display.flightWarning.value).toBe('Surface contact — recover or respawn');
  });

  /**
   * The marker half of the 10 Hz publisher. It is a separate entry point because
   * the camera pose for a frame exists only after the HUD sample, but it reads
   * the same snapshot on the same tick — one publication path, two halves.
   */
  it('projects the target diamond and the labels the caller asked for', () => {
    const snapshot = flightSnapshot();
    const store = createHudSignalStore(RADII_KM, NAMES);
    store.publish(snapshot, 0);

    store.publishWorldMarkers(snapshot, POSE, 1_600, 800, true);

    const markers = store.signals.worldMarkers;
    expect(markers.target.visible.value).toBe(true);
    expect(markers.target.xPx.value).toBeCloseTo(800, 6);
    expect(markers.target.yPx.value).toBeCloseTo(400, 6);
    expect(markers.targetDistance.value).toBe('10,000 km');
    expect(markers.labels[0]?.visible.value).toBe(true);
    expect(markers.labels[0]?.name.value).toBe('Earth');
    expect(markers.labels[0]?.distance.value).toBe('10,000 km');
    expect(markers.labels[2]?.visible.value).toBe(false);
  });

  it('drops the label layer entirely when the toggle is off', () => {
    const snapshot = flightSnapshot();
    const store = createHudSignalStore(RADII_KM, NAMES);
    store.publish(snapshot, 0);

    store.publishWorldMarkers(snapshot, POSE, 1_600, 800, false);

    for (const label of store.signals.worldMarkers.labels) {
      expect(label.visible.value).toBe(false);
    }
    // The diamond is not a label and stays.
    expect(store.signals.worldMarkers.target.visible.value).toBe(true);
  });

  it('hides every marker for a degenerate pose rather than drawing from a bad frame', () => {
    const snapshot = flightSnapshot();
    const store = createHudSignalStore(RADII_KM, NAMES);
    store.publish(snapshot, 0);

    store.publishWorldMarkers(
      snapshot,
      { ...POSE, lookDirection: { x: 0, y: 0, z: 0 } },
      1_600,
      800,
      true,
    );

    expect(store.signals.worldMarkers.target.visible.value).toBe(false);
  });
});
