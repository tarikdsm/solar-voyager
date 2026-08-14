import { describe, expect, it } from 'vitest';

import { SPEED_OF_LIGHT_KM_S } from '../core/constants.js';
import { WARP_LADDER } from '../core/time.js';
import type { Dp54Tolerance } from './propagation/dp54.js';
import { compileRailsCatalog } from './propagation/rails.js';
import { SimulationCore } from './simulation.js';
import { WarpClampReason, type SimSnapshot } from './simulationSnapshot.js';
import {
  quaternionSeparationRad,
  writeForwardFromQuaternionInto,
  writeQuaternionFromForwardInto,
} from './ship/attitude.js';
import type { BurnLogEntry, BurnLogView } from './ship/ledger.js';
import { STANDARD_GRAVITY_M_S2 } from './ship/thrust.js';
import { DEFAULT_VESSEL, type VesselConfig } from './ship/vessel.js';

const EARTH_MU_KM3_S2 = 398_600.4418;
const ORBIT_RADIUS_KM = 6_778.137;
const SHIP_MASS_KG = 10_000;

// ADR-034: these scenarios were authored against the pre-vessel 1 g drive limit.
// They are pinned to 1 g so their analytic expectations stay exact under the new
// 10 g DEFAULT_VESSEL.
const ONE_G_VESSEL: VesselConfig = {
  restMassKg: SHIP_MASS_KG,
  alphaMaxMS2: STANDARD_GRAVITY_M_S2,
  alphaManualMaxMS2: STANDARD_GRAVITY_M_S2,
  maxSlewRadPerSimS: DEFAULT_VESSEL.maxSlewRadPerSimS,
};

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

function farFieldState(): Float64Array {
  return new Float64Array([1e12, 0, 0, 0, 1, 0, 0]);
}

function verificationTolerance(maxAcceptedSteps = 4_000): Dp54Tolerance {
  return {
    absolute: new Float64Array([2e-8, 2e-8, 2e-8, 2e-11, 2e-11, 2e-11, 1e-6]),
    relative: 2e-11,
    initialStepSec: 1,
    maxAcceptedSteps,
  };
}

function relativeError(actual: number, expected: number): number {
  return Math.abs(actual - expected) / Math.max(Math.abs(actual), Math.abs(expected));
}

function stubRendererConsume(snapshot: SimSnapshot): number {
  return (snapshot.bodyPositionsKm[0] as number) + (snapshot.shipState[0] as number);
}

function copyBurnLog(log: BurnLogView): {
  readonly active: BurnLogEntry | null;
  readonly entries: readonly BurnLogEntry[];
} {
  const entries: BurnLogEntry[] = [];
  for (let index = 0; index < log.count; index += 1) {
    const entry = log.get(index);
    if (entry !== null) entries.push({ ...entry });
  }
  return {
    active: log.activeBurn === null ? null : { ...log.activeBurn },
    entries,
  };
}

function copyPersistentSnapshot(snapshot: SimSnapshot) {
  return {
    attitudeMode: snapshot.attitudeMode,
    attitudeQuaternion: [...snapshot.attitudeQuaternion],
    bodyPositionsKm: [...snapshot.bodyPositionsKm],
    bodyVelocitiesKmS: [...snapshot.bodyVelocitiesKmS],
    effectiveWarp: snapshot.effectiveWarp,
    energySpentJ: snapshot.energySpentJ,
    kineticEnergyChangeJ: snapshot.kineticEnergyChangeJ,
    properDeltaVMS: snapshot.properDeltaVMS,
    requestedWarp: snapshot.requestedWarp,
    shipState: [...snapshot.shipState],
    simTimeSec: snapshot.simTimeSec,
    targetBodyId: snapshot.targetBodyId,
    throttle: snapshot.throttle,
    warpClampReason: snapshot.warpClampReason,
  };
}

// ADR-035: a budget that always covers theta_err makes the pursuit copy the target
// verbatim at every stage, which is precisely the pre-ADR-035 snap. This is the
// baseline every "unchanged once converged" assertion below diffs against.
const SNAPPING_VESSEL: VesselConfig = { ...ONE_G_VESSEL, maxSlewRadPerSimS: 1e9 };
const HALF_TURN_SLEW_SEC = Math.PI / DEFAULT_VESSEL.maxSlewRadPerSimS;

function quaternionForForward(x: number, y: number, z: number): Float64Array {
  return writeQuaternionFromForwardInto(new Float64Array(4), x, y, z);
}

/** Steps at a fixed wall cadence until the published attitude reaches `target`. */
function stepUntilAligned(
  core: SimulationCore,
  target: Float64Array,
  wallDtSec: number,
  maxFrames: number,
): { readonly wallSec: number; readonly simSec: number } {
  const startSimTimeSec = core.snapshot.simTimeSec;
  for (let frame = 1; frame <= maxFrames; frame += 1) {
    const snapshot = core.step(wallDtSec);
    if (quaternionSeparationRad(snapshot.attitudeQuaternion, target) < 1e-9) {
      return { wallSec: frame * wallDtSec, simSec: snapshot.simTimeSec - startSimTimeSec };
    }
  }
  throw new Error('attitude hold never converged');
}

describe('SimulationCore attitude slew — ADR-035 / physics-spec.md §3.0.1', () => {
  const PROGRADE = quaternionForForward(0, 1, 0);
  const RETROGRADE = quaternionForForward(0, -1, 0);

  function farFieldCore(vessel: VesselConfig = DEFAULT_VESSEL): SimulationCore {
    return new SimulationCore({
      catalog: earthCatalog(),
      initialShipState: farFieldState(),
      vessel,
    });
  }

  it('pursues the hold direction at the vessel rate instead of snapping to it', () => {
    const core = farFieldCore();
    core.commands.setAttitudeMode('prograde');

    // One second in: 15 deg travelled, 75 deg still to go. The pre-ADR-035 code
    // published the target on the very first evaluation.
    const snapshot = core.step(1);
    expect(quaternionSeparationRad(snapshot.attitudeQuaternion, PROGRADE)).toBeCloseTo(
      Math.PI / 2 - DEFAULT_VESSEL.maxSlewRadPerSimS,
      9,
    );
    expect(quaternionSeparationRad(snapshot.attitudeQuaternion, PROGRADE)).toBeGreaterThan(1);
  });

  it('converges in theta / maxSlewRadPerSimS, within one frame', () => {
    const core = farFieldCore();
    core.commands.setAttitudeMode('prograde');
    const wallDtSec = 1 / 60;

    const converged = stepUntilAligned(core, PROGRADE, wallDtSec, 1_000);

    const analyticSec = Math.PI / 2 / DEFAULT_VESSEL.maxSlewRadPerSimS;
    expect(converged.simSec).toBeGreaterThanOrEqual(analyticSec);
    expect(converged.simSec - analyticSec).toBeLessThanOrEqual(wallDtSec);
  });

  it('scales a 180 degree flip with warp: 12 s of sim time at every tier', () => {
    const wallDtSec = 1 / 60;
    // Plan §3.2 and the T0107 acceptance list say "warp >= 5x completes in <=
    // 0.24/0.25 s wall". That is arithmetically impossible at the contract slew
    // rate: pi / 0.261799 = 12.000 s of SIM time, so 0.24 s wall is the 50x
    // figure and 5x is a lost factor of ten (ADR-035 records the correction).
    // Both figures are asserted here, each at the tier where it is true.
    const measured = new Map<number, { readonly wallSec: number; readonly simSec: number }>();
    for (const warp of [1, 5, 50] as const) {
      const core = farFieldCore();
      core.commands.setAttitudeMode('prograde');
      stepUntilAligned(core, PROGRADE, wallDtSec, 10_000);
      core.commands.setAttitudeMode('retrograde');
      core.commands.setWarp(warp);
      measured.set(warp, stepUntilAligned(core, RETROGRADE, wallDtSec, 10_000));
    }

    for (const [warp, result] of measured) {
      // Sim-time cost of the manoeuvre is warp-independent by construction.
      expect(result.simSec).toBeGreaterThanOrEqual(HALF_TURN_SLEW_SEC);
      expect(result.simSec - HALF_TURN_SLEW_SEC).toBeLessThanOrEqual(wallDtSec * warp);
      expect(result.wallSec).toBeCloseTo(result.simSec / warp, 1);
    }
    expect(measured.get(1)?.wallSec).toBeGreaterThan(11);
    expect(measured.get(5)?.wallSec).toBeLessThanOrEqual(2.5);
    expect(measured.get(50)?.wallSec).toBeLessThanOrEqual(0.25);
  });

  it('slews at the restored vessel rate, not the default one', () => {
    const catalog = earthCatalog();
    const slowVessel: VesselConfig = { ...DEFAULT_VESSEL, maxSlewRadPerSimS: 0.02 };
    const original = new SimulationCore({
      catalog,
      initialShipState: farFieldState(),
      vessel: slowVessel,
    });
    const restored = new SimulationCore({
      catalog,
      initialShipState: farFieldState(),
      vessel: DEFAULT_VESSEL,
      persistentState: original.exportPersistentState(),
    });

    expect(restored.vessel.maxSlewRadPerSimS).toBe(0.02);
    restored.commands.setAttitudeMode('prograde');
    const snapshot = restored.step(1);

    // 0.02 rad in one second, not the 0.261799 rad DEFAULT_VESSEL would give.
    expect(quaternionSeparationRad(snapshot.attitudeQuaternion, PROGRADE)).toBeCloseTo(
      Math.PI / 2 - 0.02,
      9,
    );
  });

  it('thrusts along the attitude it actually holds, not along the hold target', () => {
    const core = farFieldCore(ONE_G_VESSEL);
    core.commands.setAttitudeMode('prograde');
    core.commands.setThrottle(1);

    const snapshot = core.step(1);
    const forward = new Float64Array(3);
    writeForwardFromQuaternionInto(forward, snapshot.attitudeQuaternion);
    const thrust = snapshot.shipProperAccelerationKmS2;
    const thrustMagnitude = Math.hypot(...thrust);
    const alongForward =
      ((forward[0] as number) * (thrust[0] as number) +
        (forward[1] as number) * (thrust[1] as number) +
        (forward[2] as number) * (thrust[2] as number)) /
      thrustMagnitude;

    expect(alongForward).toBeGreaterThan(1 - 1e-12);
    // Still ~75 deg away from the commanded prograde direction.
    expect((thrust[1] as number) / thrustMagnitude).toBeLessThan(0.3);
  });

  it('publishes one attitude per simulation time however the integrator subdivides', () => {
    const single = farFieldCore();
    const laddered = farFieldCore();
    single.commands.setAttitudeMode('prograde');
    laddered.commands.setAttitudeMode('prograde');
    laddered.commands.setWarp(5);

    // Same frame anchor and same endpoint t = 4 s, mid-slew; the ladder splits the
    // frame into [0,0.8] and [0.8,4] while the other integrates [0,4] in one go.
    const singleSnapshot = single.step(4);
    const ladderedSnapshot = laddered.step(0.8);

    expect(ladderedSnapshot.simTimeSec).toBe(singleSnapshot.simTimeSec);
    expect(quaternionSeparationRad(singleSnapshot.attitudeQuaternion, PROGRADE)).toBeGreaterThan(
      0.5,
    );
    expect(
      quaternionSeparationRad(
        singleSnapshot.attitudeQuaternion,
        ladderedSnapshot.attitudeQuaternion,
      ),
    ).toBeLessThan(1e-12);
  });

  it('drifts under 1e-3 km from the pre-ADR-035 snap over a converged LEO orbit', () => {
    const periodSec = 2 * Math.PI * Math.sqrt(ORBIT_RADIUS_KM ** 3 / EARTH_MU_KM3_S2);
    const alignmentSec = Math.PI / 2 / ONE_G_VESSEL.maxSlewRadPerSimS + 1;
    const frameSec = 1;
    const slewed = new SimulationCore({
      catalog: earthCatalog(),
      initialShipState: circularState(),
      vessel: ONE_G_VESSEL,
    });
    const snapped = new SimulationCore({
      catalog: earthCatalog(),
      initialShipState: circularState(),
      vessel: SNAPPING_VESSEL,
    });

    for (const core of [slewed, snapped]) {
      core.commands.setAttitudeMode('prograde');
      core.step(alignmentSec);
      core.commands.setThrottle(0.02);
      for (let elapsedSec = 0; elapsedSec < periodSec; elapsedSec += frameSec) {
        core.step(frameSec);
      }
    }

    const driftKm = Math.hypot(
      (slewed.snapshot.shipState[0] as number) - (snapped.snapshot.shipState[0] as number),
      (slewed.snapshot.shipState[1] as number) - (snapped.snapshot.shipState[1] as number),
      (slewed.snapshot.shipState[2] as number) - (snapped.snapshot.shipState[2] as number),
    );

    // A converged hold does not approximate the old snap, it reproduces it: the
    // budget covers theta_err at every stage and the target is copied verbatim.
    expect(driftKm).toBeLessThan(1e-3);
    expect(driftKm).toBe(0);
  });

  it('prices a converged hold identically at 1x and 100x', () => {
    const alignmentSec = Math.PI / 2 / ONE_G_VESSEL.maxSlewRadPerSimS + 1;
    const realtime = new SimulationCore({
      catalog: earthCatalog(),
      initialShipState: circularState(),
      vessel: ONE_G_VESSEL,
      integrationTolerance: verificationTolerance(),
    });
    const warped = new SimulationCore({
      catalog: earthCatalog(),
      initialShipState: circularState(),
      vessel: ONE_G_VESSEL,
      integrationTolerance: verificationTolerance(),
    });
    for (const core of [realtime, warped]) {
      core.commands.setAttitudeMode('prograde');
      core.step(alignmentSec);
      core.commands.setThrottle(0.4);
    }
    warped.commands.setWarp(100);

    let realtimeSnapshot = realtime.snapshot;
    let warpedSnapshot = warped.snapshot;
    for (let frame = 0; frame < 1_000; frame += 1) realtimeSnapshot = realtime.step(0.01);
    for (let frame = 0; frame < 10; frame += 1) warpedSnapshot = warped.step(0.01);

    expect(warpedSnapshot.simTimeSec).toBeCloseTo(realtimeSnapshot.simTimeSec, 9);
    expect(realtimeSnapshot.energySpentJ).toBeGreaterThan(0);
    expect(relativeError(warpedSnapshot.energySpentJ, realtimeSnapshot.energySpentJ)).toBeLessThan(
      1e-12,
    );
    expect(
      relativeError(warpedSnapshot.properDeltaVMS, realtimeSnapshot.properDeltaVMS),
    ).toBeLessThan(1e-12);
    expect(
      quaternionSeparationRad(
        warpedSnapshot.attitudeQuaternion,
        realtimeSnapshot.attitudeQuaternion,
      ),
    ).toBeLessThan(1e-9);
  });
});

describe('SimulationCore vessel configuration — ADR-034', () => {
  it('reaches the 10 g default drive limit and prices it as P = m*alpha*c', () => {
    const throttle = 0.75;
    const core = new SimulationCore({
      catalog: earthCatalog(),
      initialShipState: circularState(),
      vessel: DEFAULT_VESSEL,
    });
    core.commands.setAttitudeMode('prograde');
    core.commands.setThrottle(throttle);

    const snapshot = core.step(1);

    // physics-spec.md §3.0.1 — alpha = f * alpha_max, F = m*alpha, P = F*c.
    const expectedAccelerationKmS2 = (throttle * DEFAULT_VESSEL.alphaMaxMS2) / 1_000;
    const expectedForceN = DEFAULT_VESSEL.restMassKg * throttle * DEFAULT_VESSEL.alphaMaxMS2;
    const expectedPowerW = expectedForceN * SPEED_OF_LIGHT_KM_S * 1_000;
    const actualAccelerationKmS2 = Math.hypot(...snapshot.shipProperAccelerationKmS2);

    expect(relativeError(actualAccelerationKmS2, expectedAccelerationKmS2)).toBeLessThan(1e-12);
    expect(relativeError(Math.hypot(...snapshot.shipThrustVectorN), expectedForceN)).toBeLessThan(
      1e-12,
    );
    expect(relativeError(snapshot.powerDrawW, expectedPowerW)).toBeLessThan(1e-12);
    // 0.75 throttle already commands 7.5 g — unreachable at any throttle under the
    // pre-ADR-034 1 g ceiling, so the new limit is genuinely in force, not clamped.
    expect((actualAccelerationKmS2 * 1_000) / STANDARD_GRAVITY_M_S2).toBeCloseTo(7.5, 12);
  });

  it('publishes the vessel it flies and validates it at construction', () => {
    const core = new SimulationCore({
      catalog: earthCatalog(),
      initialShipState: circularState(),
      vessel: DEFAULT_VESSEL,
    });

    expect(core.vessel).toEqual(DEFAULT_VESSEL);
    expect(Object.isFrozen(core.vessel)).toBe(true);
    expect(
      () =>
        new SimulationCore({
          catalog: earthCatalog(),
          initialShipState: circularState(),
          vessel: { ...DEFAULT_VESSEL, restMassKg: 0 },
        }),
    ).toThrow(/rest mass/u);
  });

  it('restores the persisted vessel in preference to the constructor vessel', () => {
    const catalog = earthCatalog();
    const original = new SimulationCore({
      catalog,
      initialShipState: circularState(),
      vessel: DEFAULT_VESSEL,
    });
    original.commands.setAttitudeMode('prograde');
    original.commands.setThrottle(1);
    original.step(1);
    const saved = original.exportPersistentState();

    // The persistent ledger was priced at 10 g; restoring under a 1 g vessel must
    // not silently re-price it.
    const restored = new SimulationCore({
      catalog,
      initialShipState: circularState(),
      vessel: ONE_G_VESSEL,
      persistentState: saved,
    });

    expect(saved.vessel).toEqual(DEFAULT_VESSEL);
    expect(restored.vessel).toEqual(DEFAULT_VESSEL);
    expect(restored.snapshot.powerDrawW).toBe(original.snapshot.powerDrawW);
    expect(restored.snapshot.energySpentJ).toBe(original.snapshot.energySpentJ);
  });

  it('uses the constructor vessel for a fresh session', () => {
    const core = new SimulationCore({
      catalog: earthCatalog(),
      initialShipState: circularState(),
      vessel: ONE_G_VESSEL,
    });
    core.commands.setThrottle(1);
    const snapshot = core.step(1);

    expect(core.vessel.alphaMaxMS2).toBe(STANDARD_GRAVITY_M_S2);
    expect(Math.hypot(...snapshot.shipProperAccelerationKmS2)).toBeCloseTo(
      STANDARD_GRAVITY_M_S2 / 1_000,
      14,
    );
  });
});

describe('SimulationCore', () => {
  it('exports and restores the complete simulation continuation state', () => {
    const catalog = earthCatalog();
    const original = new SimulationCore({
      catalog,
      initialShipState: circularState(),
      vessel: ONE_G_VESSEL,
    });
    original.commands.setTarget('earth');
    original.commands.setAttitudeMode('prograde');
    original.commands.setThrottle(0.2);
    original.step(1);
    original.commands.setThrottle(0);
    original.commands.setAttitudeMode('manual');
    original.commands.rotate(0.01, -0.02, 0.03);
    original.commands.setWarp(5);
    original.commands.setThrottle(0.3);
    original.step(0.2);

    const saved = original.exportPersistentState();
    const restored = new SimulationCore({
      catalog,
      initialShipState: circularState(),
      vessel: ONE_G_VESSEL,
      persistentState: saved,
    });

    expect(copyPersistentSnapshot(restored.snapshot)).toEqual(
      copyPersistentSnapshot(original.snapshot),
    );
    expect(copyBurnLog(restored.burnLog)).toEqual(copyBurnLog(original.burnLog));
    expect(copyPersistentSnapshot(restored.step(0.25))).toEqual(
      copyPersistentSnapshot(original.step(0.25)),
    );
    expect(copyBurnLog(restored.burnLog)).toEqual(copyBurnLog(original.burnLog));
  });

  it('publishes a render-consumable initial snapshot and exactly two frame buffers', () => {
    const core = new SimulationCore({
      catalog: earthCatalog(),
      initialShipState: circularState(),
      vessel: ONE_G_VESSEL,
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

  it('publishes proper acceleration, thrust, and photon-drive power', () => {
    const core = new SimulationCore({
      catalog: earthCatalog(),
      initialShipState: circularState(),
      vessel: ONE_G_VESSEL,
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
    const expectedAccelerationKmS2 = (0.6 * STANDARD_GRAVITY_M_S2) / 1_000;
    expect(Math.hypot(...snapshot.shipProperAccelerationKmS2)).toBeCloseTo(
      expectedAccelerationKmS2,
      14,
    );
    const expectedForceN = SHIP_MASS_KG * expectedAccelerationKmS2 * 1_000;
    expect(Math.hypot(...snapshot.shipThrustVectorN)).toBeCloseTo(expectedForceN, 9);
    expect(snapshot.powerDrawW).toBeCloseTo(expectedForceN * SPEED_OF_LIGHT_KM_S * 1_000, 0);
    expect(snapshot.shipState[4] as number).toBeGreaterThan(circularState()[4] as number);
    expect(snapshot.energySpentJ).toBeCloseTo(snapshot.powerDrawW * 10, 0);
    expect(snapshot.properDeltaVMS).toBeGreaterThan(0);
  });

  it('keeps prograde hold tangent while the ship advances through its orbit', () => {
    const core = new SimulationCore({
      catalog: earthCatalog(),
      initialShipState: circularState(),
      vessel: ONE_G_VESSEL,
      integrationTolerance: verificationTolerance(),
    });
    core.commands.setAttitudeMode('prograde');
    const periodSec = 2 * Math.PI * Math.sqrt(ORBIT_RADIUS_KM ** 3 / EARTH_MU_KM3_S2);

    const snapshot = core.step(periodSec / 4);
    const forward = new Float64Array(3);
    writeForwardFromQuaternionInto(forward, snapshot.attitudeQuaternion);
    const speed = Math.hypot(...snapshot.shipCoordinateVelocityKmS);
    const alignment =
      ((forward[0] as number) * (snapshot.shipCoordinateVelocityKmS[0] as number) +
        (forward[1] as number) * (snapshot.shipCoordinateVelocityKmS[1] as number) +
        (forward[2] as number) * (snapshot.shipCoordinateVelocityKmS[2] as number)) /
      speed;

    expect(alignment).toBeGreaterThan(1 - 1e-12);
  });

  it('evaluates manual yaw rates exactly and commits only successful attitude', () => {
    const core = new SimulationCore({
      catalog: earthCatalog(),
      initialShipState: circularState(),
      vessel: ONE_G_VESSEL,
    });
    core.commands.rotate(0, Math.PI / 2, 0);

    const snapshot = core.step(1);
    const forward = new Float64Array(3);
    writeForwardFromQuaternionInto(forward, snapshot.attitudeQuaternion);
    expect(forward[0]).toBeCloseTo(0, 13);
    expect(forward[1]).toBeCloseTo(1, 13);
    expect(forward[2]).toBeCloseTo(0, 13);
  });

  it('forwards thrust-command invalidation without duplicate events', () => {
    let invalidations = 0;
    const core = new SimulationCore({
      catalog: earthCatalog(),
      initialShipState: circularState(),
      vessel: ONE_G_VESSEL,
      onTrajectoryInvalidated: () => {
        invalidations += 1;
      },
    });

    core.commands.setThrottle(0.4);
    core.commands.setThrottle(0.4);
    core.commands.setAttitudeMode('prograde');
    expect(invalidations).toBe(2);
  });

  it('does not let a mutated published ship array alter private physical state', () => {
    const core = new SimulationCore({
      catalog: earthCatalog(),
      initialShipState: circularState(),
      vessel: ONE_G_VESSEL,
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
      vessel: ONE_G_VESSEL,
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
      vessel: ONE_G_VESSEL,
      integrationTolerance: verificationTolerance(0),
    });
    const initial = core.snapshot;
    core.commands.rotate(0, Math.PI / 2, 0);

    expect(() => core.step(-1)).toThrow(/wall delta/u);
    expect(() => core.step(Number.NaN)).toThrow(/wall delta/u);
    expect(() => core.step(1)).toThrow(/integration budget/u);
    expect(core.snapshot).toBe(initial);
    expect(core.snapshot.simTimeSec).toBe(0);
    expect(core.snapshot.shipState[0]).toBe(ORBIT_RADIUS_KM);
    expect(core.snapshot.attitudeQuaternion).toEqual(new Float64Array([0, 0, 0, 1]));
  });

  it('clamps requested 1e7x in LEO to a canonical tier within the 4000-step budget', () => {
    const core = new SimulationCore({
      catalog: earthCatalog(),
      initialShipState: circularState(),
      vessel: ONE_G_VESSEL,
    });
    core.commands.setWarp(1e7);

    const snapshot = core.step(1);

    expect(snapshot.requestedWarp).toBe(1e7);
    expect(snapshot.effectiveWarp).toBeLessThan(1e7);
    expect(WARP_LADDER).toContain(snapshot.effectiveWarp);
    expect(snapshot.simTimeSec).toBe(snapshot.effectiveWarp);
    expect(snapshot.warpClampReason).toBe(WarpClampReason.INTEGRATION_BUDGET);
  });

  it('sustains requested 1e7x in deep space and exposes coast-only thrust lockout', () => {
    const core = new SimulationCore({
      catalog: earthCatalog(),
      initialShipState: farFieldState(),
      vessel: ONE_G_VESSEL,
    });
    core.commands.setThrottle(0.5);
    core.commands.setWarp(1e7);

    const snapshot = core.step(1);

    expect(snapshot.simTimeSec).toBe(1e7);
    expect(snapshot.requestedWarp).toBe(1e7);
    expect(snapshot.effectiveWarp).toBe(1e7);
    expect(snapshot.warpClampReason).toBe(WarpClampReason.THRUST_LOCKOUT);
    expect(snapshot.throttle).toBe(0);
    expect(snapshot.powerDrawW).toBe(0);
    expect(snapshot.shipProperAccelerationKmS2).toEqual(new Float64Array(3));
    expect(core.burnLog.activeBurn).toBeNull();
    expect(core.burnLog.count).toBe(0);
  });

  it('publishes the highest completed checkpoint when the shared budget is exhausted', () => {
    const tolerance = verificationTolerance(7);
    tolerance.initialStepSec = 0.01;
    const core = new SimulationCore({
      catalog: earthCatalog(),
      initialShipState: farFieldState(),
      vessel: ONE_G_VESSEL,
      integrationTolerance: tolerance,
    });
    const checkpointCore = new SimulationCore({
      catalog: earthCatalog(),
      initialShipState: farFieldState(),
      vessel: ONE_G_VESSEL,
      integrationTolerance: tolerance,
    });
    core.commands.setThrottle(0.4);
    core.commands.setWarp(10);
    checkpointCore.commands.setThrottle(0.4);
    checkpointCore.commands.setWarp(5);

    const snapshot = core.step(1);
    const checkpointSnapshot = checkpointCore.step(1);

    expect(snapshot.requestedWarp).toBe(10);
    expect(snapshot.effectiveWarp).toBe(5);
    expect(snapshot.simTimeSec).toBe(5);
    expect(snapshot.warpClampReason).toBe(WarpClampReason.INTEGRATION_BUDGET);
    expect(snapshot.shipState).toEqual(checkpointSnapshot.shipState);
    expect(snapshot.energySpentJ).toBeCloseTo(snapshot.powerDrawW * 5, 0);
    expect(snapshot.energySpentJ).toBeCloseTo(checkpointSnapshot.energySpentJ, 0);
    expect(snapshot.properDeltaVMS).toBeGreaterThan(0);
  });

  it('keeps equivalent physical horizons stable across warp changes', () => {
    const warped = new SimulationCore({
      catalog: earthCatalog(),
      initialShipState: circularState(),
      vessel: ONE_G_VESSEL,
      integrationTolerance: verificationTolerance(),
    });
    const realtime = new SimulationCore({
      catalog: earthCatalog(),
      initialShipState: circularState(),
      vessel: ONE_G_VESSEL,
      integrationTolerance: verificationTolerance(),
    });
    warped.commands.setThrottle(0.2);
    warped.commands.setAttitudeMode('prograde');
    warped.commands.setWarp(100);
    realtime.commands.setThrottle(0.2);
    realtime.commands.setAttitudeMode('prograde');

    const warpedSnapshot = warped.step(0.1);
    const realtimeSnapshot = realtime.step(10);

    expect(warpedSnapshot.simTimeSec).toBe(realtimeSnapshot.simTimeSec);
    expect(warpedSnapshot.shipProperTimeSec).toBeCloseTo(realtimeSnapshot.shipProperTimeSec, 8);
    for (let index = 0; index < warpedSnapshot.shipState.length; index += 1) {
      expect(warpedSnapshot.shipState[index]).toBeCloseTo(
        realtimeSnapshot.shipState[index] as number,
        7,
      );
    }
  });
});
