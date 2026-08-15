import { describe, expect, it } from 'vitest';

import { SPEED_OF_LIGHT_KM_S } from '../core/constants.js';
import { predictThrustFreeTrajectory } from './analysis/trajectoryPredictor.js';
import {
  PREDICTOR_EVENT_CODE_OFFSET,
  PREDICTOR_EVENT_STRIDE,
  PredictorEventCode,
} from './analysis/trajectoryPredictionLayout.js';
import { CONTACT_TIME_TOLERANCE_SEC } from './analysis/surfaceCollision.js';
import { compileRailsCatalog } from './propagation/rails.js';
import { SimulationCore } from './simulation.js';
import { WarningFlag } from './simulationSnapshot.js';
import { copyAndValidateSimulationPersistentState } from './simulationState.js';
import { STANDARD_GRAVITY_M_S2 } from './ship/thrust.js';
import { DEFAULT_VESSEL, type VesselConfig } from './ship/vessel.js';

const EARTH_MU_KM3_S2 = 398_600.4418;
const EARTH_RADIUS_KM = 6_371;
const SHIP_MASS_KG = 10_000;

const ONE_G_VESSEL: VesselConfig = {
  restMassKg: SHIP_MASS_KG,
  alphaMaxMS2: STANDARD_GRAVITY_M_S2,
  alphaManualMaxMS2: STANDARD_GRAVITY_M_S2,
  maxSlewRadPerSimS: DEFAULT_VESSEL.maxSlewRadPerSimS,
};

/** Single root body at the origin, so rails motion never confuses a geometry test. */
function earthCatalog(atmosphereTopKm: number | null = null) {
  return compileRailsCatalog([
    {
      id: 'earth',
      parentId: null,
      muKm3S2: EARTH_MU_KM3_S2,
      elements: null,
      meanRadiusKm: EARTH_RADIUS_KM,
      surface: { atmosphereTopKm },
    },
  ]);
}

function restingState(radiusKm: number): Float64Array {
  return new Float64Array([radiusKm, 0, 0, 0, 0, 0, 0]);
}

function circularState(radiusKm: number): Float64Array {
  const speedKmS = Math.sqrt(EARTH_MU_KM3_S2 / radiusKm);
  const gamma = 1 / Math.sqrt(1 - (speedKmS / SPEED_OF_LIGHT_KM_S) ** 2);
  return new Float64Array([radiusKm, 0, 0, 0, gamma * speedKmS, 0, 0]);
}

/**
 * Newtonian radial free-fall time from rest at `startRadiusKm` down to
 * `endRadiusKm`. Relativistic and n-body corrections at LEO speeds are ~1e-9 s,
 * three orders below the 1 ms bound this pins.
 */
function radialFallTimeSec(startRadiusKm: number, endRadiusKm: number): number {
  const ratio = endRadiusKm / startRadiusKm;
  return (
    Math.sqrt(startRadiusKm ** 3 / (2 * EARTH_MU_KM3_S2)) *
    (Math.acos(Math.sqrt(ratio)) + Math.sqrt(ratio * (1 - ratio)))
  );
}

function createCore(initialShipState: Float64Array, atmosphereTopKm: number | null = null) {
  return new SimulationCore({
    catalog: earthCatalog(atmosphereTopKm),
    initialShipState,
    vessel: ONE_G_VESSEL,
  });
}

/** Steps until contact or the horizon; returns the published snapshot. */
function flyUntilImpact(core: SimulationCore, frameSec: number, horizonSec: number) {
  const frames = Math.ceil(horizonSec / frameSec);
  for (let frame = 0; frame < frames; frame += 1) {
    const snapshot = core.step(frameSec);
    if (snapshot.impactOccurred === 1) return snapshot;
  }
  return core.snapshot;
}

describe('surface collision - physics-spec.md section 6, ADR-036', () => {
  // Both frame sizes, because the bisection is what earns the 1 ms bound and a
  // 1 s frame barely needs it: at 30 s the accepted step spans ~25 km of fall.
  it.each([1, 30])(
    'fires a head-on decay impact within 1 ms of the analytic crossing (%d s frames)',
    (frameSec) => {
      const startRadiusKm = EARTH_RADIUS_KM + 400;
      const core = createCore(restingState(startRadiusKm));
      const expectedSec = radialFallTimeSec(startRadiusKm, EARTH_RADIUS_KM);

      const snapshot = flyUntilImpact(core, frameSec, expectedSec + 120);

      expect(snapshot.impactOccurred).toBe(1);
      expect(snapshot.impactBodyIndex).toBe(0);
      expect(Math.abs(snapshot.impactSimTimeSec - expectedSec)).toBeLessThanOrEqual(
        CONTACT_TIME_TOLERANCE_SEC,
      );
      // The contact state is at or outside the sphere, never inside it: this is
      // what keeps the nbodyForces central singularity unreachable (ADR-036 §6).
      expect(Math.hypot(...snapshot.shipState.subarray(0, 3))).toBeGreaterThanOrEqual(
        EARTH_RADIUS_KM,
      );
    },
  );

  it('reports the closing speed and freezes the clock at contact', () => {
    const startRadiusKm = EARTH_RADIUS_KM + 400;
    const core = createCore(restingState(startRadiusKm));
    const analyticSpeedKmS = Math.sqrt(
      2 * EARTH_MU_KM3_S2 * (1 / EARTH_RADIUS_KM - 1 / startRadiusKm),
    );

    const snapshot = flyUntilImpact(core, 1, 400);

    expect(snapshot.impactOccurred).toBe(1);
    expect(snapshot.impactSpeedKmS).toBeCloseTo(analyticSpeedKmS, 5);
    expect(snapshot.simTimeSec).toBe(snapshot.impactSimTimeSec);
  });

  it('does not fire on a graze whose periapsis clears the surface by 100 m', () => {
    // 20 s frames deliberately: `surfaceCollision.test.ts` proves the chord test
    // fires on exactly this geometry over a 20 s step (sag ~0.35 km against
    // 0.1 km of clearance), so this case only passes because the confirmation
    // pass rejects it. At 1 s frames the sag is 1.2 m and the test would pass
    // without ever reaching the code it is meant to cover.
    const radiusKm = EARTH_RADIUS_KM + 0.1;
    const core = createCore(circularState(radiusKm));
    const periodSec = 2 * Math.PI * Math.sqrt(radiusKm ** 3 / EARTH_MU_KM3_S2);

    const snapshot = flyUntilImpact(core, 20, periodSec * 1.05);

    expect(snapshot.impactOccurred).toBe(0);
    expect(snapshot.impactBodyIndex).toBe(-1);
    expect(snapshot.simTimeSec).toBeGreaterThan(periodSec);
    expect(Math.hypot(...snapshot.shipState.subarray(0, 3))).toBeGreaterThan(EARTH_RADIUS_KM);
  });

  it('fires on a thrusting descent the thrust-free predictor never sees', () => {
    const radiusKm = EARTH_RADIUS_KM + 400;
    const initialShipState = circularState(radiusKm);
    const catalog = earthCatalog();

    // The predictor is thrust-free by construction, so from this state it
    // forecasts the circular orbit it started on and raises no impact.
    const prediction = predictThrustFreeTrajectory({
      catalog,
      collisionRadiiKm: catalog.collisionRadiiKm,
      startTimeSec: 0,
      horizonSec: 8 * 3_600,
      shipState: initialShipState,
      dominantBodyIndex: 0,
      outputPointCount: 512,
    });
    const predictedCodes: number[] = [];
    for (let offset = 0; offset < prediction.events.length; offset += PREDICTOR_EVENT_STRIDE) {
      predictedCodes.push(prediction.events[offset + PREDICTOR_EVENT_CODE_OFFSET] as number);
    }
    expect(predictedCodes).not.toContain(PredictorEventCode.Impact);

    // The same state, flown with the drive pointed at the planet, hits it.
    const core = createCore(initialShipState);
    core.commands.setAttitudeMode('radialIn');
    core.commands.setThrottle(1);
    const snapshot = flyUntilImpact(core, 1, 8 * 3_600);

    expect(snapshot.impactOccurred).toBe(1);
    expect(snapshot.impactBodyIndex).toBe(0);
    expect(snapshot.impactSpeedKmS).toBeGreaterThan(0);
  });

  it('makes step a no-op and pins warp at 1x once frozen', () => {
    const core = createCore(restingState(EARTH_RADIUS_KM + 400));
    core.commands.setWarp(50);
    const impact = flyUntilImpact(core, 1, 400);
    expect(impact.impactOccurred).toBe(1);

    const frozenTimeSec = impact.simTimeSec;
    const frozenState = Float64Array.from(impact.shipState);
    const frozenEnergyJ = impact.energySpentJ;

    core.commands.setWarp(1_000);
    core.commands.setThrottle(1);
    core.commands.rotate(0.5, 0.5, 0.5);
    for (let frame = 0; frame < 32; frame += 1) core.step(1);
    const after = core.snapshot;

    expect(after.simTimeSec).toBe(frozenTimeSec);
    expect([...after.shipState]).toEqual([...frozenState]);
    expect(after.energySpentJ).toBe(frozenEnergyJ);
    expect(after.effectiveWarp).toBe(1);
    expect(after.requestedWarp).toBe(1);
    expect(after.throttle).toBe(0);
    expect(after.impactOccurred).toBe(1);
  });

  it('raises the IMPACT warning flag, which nothing wrote before this task', () => {
    const core = createCore(restingState(EARTH_RADIUS_KM + 400));
    expect(core.snapshot.warningFlags).toBe(WarningFlag.NONE);

    const snapshot = flyUntilImpact(core, 1, 400);

    expect(snapshot.impactOccurred).toBe(1);
    expect(snapshot.warningFlags & WarningFlag.IMPACT).toBe(WarningFlag.IMPACT);
  });

  it('keeps the fail-open probe counter observable and at zero in normal flight', () => {
    // A silent fail-open is indistinguishable from working, so the counter is
    // part of the contract even though it is expected never to move.
    const core = createCore(circularState(EARTH_RADIUS_KM + 0.1));
    for (let frame = 0; frame < 200; frame += 1) core.step(20);
    expect(core.surfaceProbeFailureCount).toBe(0);

    const impacting = createCore(restingState(EARTH_RADIUS_KM + 400));
    flyUntilImpact(impacting, 1, 400);
    expect(impacting.surfaceProbeFailureCount).toBe(0);
  });

  it('treats a state that starts inside a body as immediate contact', () => {
    // Only reachable from a hand-edited or migrated document; `trajectoryImpact`
    // skips this case, so without the explicit guard the ship would fall through.
    const core = createCore(restingState(EARTH_RADIUS_KM * 0.5));

    const snapshot = core.step(1);

    expect(snapshot.impactOccurred).toBe(1);
    expect(snapshot.impactBodyIndex).toBe(0);
    expect(snapshot.impactSimTimeSec).toBe(0);
    expect(Number.isFinite(snapshot.shipState[0] as number)).toBe(true);
  });

  it('round-trips an impacted session and re-derives the freeze on the first step', () => {
    const core = createCore(restingState(EARTH_RADIUS_KM + 400));
    const impact = flyUntilImpact(core, 1, 400);
    expect(impact.impactOccurred).toBe(1);

    // The impact fields are derived geometry and are deliberately not persisted;
    // the reloaded core must rediscover them from the state vector alone.
    const exported = core.exportPersistentState();
    const validated = copyAndValidateSimulationPersistentState(exported, ['earth']);
    const reloaded = new SimulationCore({
      catalog: earthCatalog(),
      initialShipState: restingState(EARTH_RADIUS_KM + 400),
      vessel: ONE_G_VESSEL,
      persistentState: validated,
    });

    expect(reloaded.snapshot.impactOccurred).toBe(0);
    const resumed = reloaded.step(1);
    expect(resumed.impactOccurred).toBe(1);
    expect(resumed.impactBodyIndex).toBe(0);
  });

  it('collides against the cloud deck when a body carries an atmosphere top', () => {
    const atmosphereTopKm = 1_581;
    const startRadiusKm = EARTH_RADIUS_KM + atmosphereTopKm + 400;
    const core = createCore(restingState(startRadiusKm), atmosphereTopKm);
    const expectedSec = radialFallTimeSec(startRadiusKm, EARTH_RADIUS_KM + atmosphereTopKm);

    const snapshot = flyUntilImpact(core, 1, expectedSec + 60);

    expect(snapshot.impactOccurred).toBe(1);
    expect(Math.abs(snapshot.impactSimTimeSec - expectedSec)).toBeLessThanOrEqual(
      CONTACT_TIME_TOLERANCE_SEC,
    );
    expect(Math.hypot(...snapshot.shipState.subarray(0, 3))).toBeGreaterThanOrEqual(
      EARTH_RADIUS_KM + atmosphereTopKm,
    );
  });
});
