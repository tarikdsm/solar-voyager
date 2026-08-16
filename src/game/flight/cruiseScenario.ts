// v2 plan §5 T0116 — one deterministic cruise, driven headlessly.
//
// The same runner backs the Vitest integration tests and the Playwright CI
// cruise gate (`tests/render/cruiseDirector.html`), so the browser gate exercises
// the module the game ships rather than a re-implementation of it. Written in
// the style of `game/flightBenchmarkRoute.ts`, which does the same for the bench.

import { SPEED_OF_LIGHT_KM_S } from '../../core/constants.js';
import { relativisticStopDistanceKm } from '../../sim/guidance/brakingEnvelope.js';
import type { ArrivalIntent } from '../../sim/guidance/constantAccelIntercept.js';
import { STATE_TAU } from '../../sim/ship/relativity.js';
import { DEFAULT_VESSEL, type VesselConfig } from '../../sim/ship/vessel.js';
import type { SimSnapshot } from '../../sim/simulationSnapshot.js';
import { compileCanonicalCatalog, createNewGameSimulation } from '../createNewGameSimulation.js';

import { osculatingEccentricity } from './cruiseInsertion.js';
import { CruiseDirector, type CruisePhase } from './cruiseDirector.js';
import { FlightController } from './flightController.js';

/** Wall seconds per simulated frame; 60 fps is the project floor. */
export const SCENARIO_FRAME_DT_SEC = 1 / 60;

export interface CruiseScenarioOptions {
  readonly targetBodyId: string;
  readonly arrival?: ArrivalIntent;
  readonly arrivalAltitudeKm?: number;
  readonly vessel?: VesselConfig;
  readonly frameDtSec?: number;
  /** Hard stop, in frames. `frames * frameDtSec` is the wall-clock budget. */
  readonly maxFrames?: number;
  /** Frame index at which `abort()` is called, for the abort fuzz gate. */
  readonly abortAtFrame?: number;
  /** Frames to keep running after an abort, to prove the state stays controllable. */
  readonly framesAfterAbort?: number;
}

export interface CruiseScenarioResult {
  readonly engaged: boolean;
  readonly phase: CruisePhase;
  readonly frames: number;
  /** `frames * frameDtSec` — the unattended wall-clock cost at 60 fps. */
  readonly wallSec: number;
  readonly simTimeSec: number;
  readonly properTimeSec: number;
  readonly eccentricity: number;
  readonly radiusKm: number;
  readonly arrivalRadiusKm: number;
  readonly altitudeKm: number;
  readonly presetAltitudeKm: number;
  readonly relativeSpeedKmS: number;
  readonly energySpentJ: number;
  /** Ledger energy at the handover to `insert`, i.e. the profile's own cost. */
  readonly profileEnergySpentJ: number;
  /**
   * `m c alpha T` — the exact ADR-007 / physics-spec §5 cost of the adopted §8.4
   * profile: the ledger is the photon-drive bound `E = int m alpha c dt`, so a
   * constant-alpha burn of coordinate duration `T` costs exactly this.
   */
  readonly profilePhotonEnergyJ: number;
  readonly profileEnergyRatio: number;
  /** Coordinate seconds of thrust accumulated over the whole run, throttle-weighted. */
  readonly thrustCoordSec: number;
  /** `energySpentJ / (m c alpha t_thrust)` — the no-side-channel identity, expect 1. */
  readonly ledgerIdentityRatio: number;
  /** The plan's kinetic bound `2(gamma_peak-1) m c^2`, reported for comparison. */
  readonly kineticBoundJ: number;
  readonly analyticEnergyJ: number;
  readonly energyRatio: number;
  readonly peakBeta: number;
  readonly maxWarp: number;
  readonly resolveFailures: number;
  readonly impactOccurred: boolean;
  /** Warp tier at the last frame; the abort gate asserts this is <= 100. */
  readonly finalWarp: number;
  readonly finalThrottle: number;
  readonly finalAttitudeMode: string;
  /** Wall seconds between `abort()` and the first frame at or below 100x. */
  readonly decompressionWallSec: number;
  /** Ship still integrable and finite after the run. */
  readonly controllable: boolean;
}

function relativeStateInto(
  snapshot: SimSnapshot,
  targetIndex: number,
  position: Float64Array,
  velocity: Float64Array,
): void {
  const offset = targetIndex * 3;
  for (let axis = 0; axis < 3; axis += 1) {
    position[axis] =
      (snapshot.shipState[axis] as number) - (snapshot.bodyPositionsKm[offset + axis] as number);
    velocity[axis] =
      (snapshot.shipCoordinateVelocityKmS[axis] as number) -
      (snapshot.bodyVelocitiesKmS[offset + axis] as number);
  }
}

/**
 * Runs one unattended cruise from the canonical J2026 new game (400 km LEO).
 *
 * Deterministic: a fixed wall step, no wall clock, no randomness. The frame body
 * mirrors `bootstrap/frameLoop.ts` — the director owns the ship while it is
 * active, the flight controller owns it otherwise — so an abort here exercises
 * the same handover the game does.
 */
export function runCruiseScenario(options: CruiseScenarioOptions): CruiseScenarioResult {
  const vessel = options.vessel ?? DEFAULT_VESSEL;
  const frameDtSec = options.frameDtSec ?? SCENARIO_FRAME_DT_SEC;
  const maxFrames = options.maxFrames ?? 40_000;
  const simulation = createNewGameSimulation(vessel);
  const catalog = compileCanonicalCatalog();
  const ports = {
    commands: simulation.commands,
    snapshot: () => simulation.snapshot,
    vessel,
  };
  const controller = new FlightController(ports);
  const director = new CruiseDirector({ ...ports, catalog, controller });
  const targetIndex = catalog.bodyIds.indexOf(options.targetBodyId);
  const relPosition = new Float64Array(3);
  const relVelocity = new Float64Array(3);

  const baselineEnergyJ = simulation.snapshot.energySpentJ;
  const engaged = director.engage(
    options.targetBodyId,
    options.arrival ?? 'orbit',
    options.arrivalAltitudeKm,
  );
  const presetRadiusKm = director.arrivalRadiusKm;
  const collisionRadiusKm =
    targetIndex >= 0 ? (catalog.collisionRadiiKm[targetIndex] as number) : 0;

  let frames = 0;
  let peakBeta = 0;
  let maxWarp = 1;
  let abortFrame = -1;
  let decompressedFrame = -1;
  let thrustCoordSec = 0;
  let profileEnergySpentJ = Number.NaN;
  let previousSimTimeSec = simulation.snapshot.simTimeSec;
  let snapshot = simulation.snapshot;
  const abortAtFrame = options.abortAtFrame ?? -1;
  const framesAfterAbort = options.framesAfterAbort ?? 600;

  while (frames < maxFrames) {
    if (abortFrame < 0 && abortAtFrame >= 0 && frames >= abortAtFrame) {
      director.abort();
      abortFrame = frames;
    }
    if (!director.active && director.phase !== 'idle' && abortFrame < 0) {
      // Arrival: keep stepping only long enough for the warp to decompress.
      if (director.phase === 'done' && snapshot.requestedWarp <= 100) break;
    }
    if (abortFrame >= 0 && frames - abortFrame >= framesAfterAbort) break;
    director.update(frameDtSec);
    if (!director.active) controller.update(frameDtSec);
    const previousThrottle = snapshot.throttle;
    snapshot = simulation.step(frameDtSec);
    frames += 1;
    // Throttle-weighted coordinate thrust time. Sampled at both ends of the step
    // and averaged, because the only frames where the two differ are the ones a
    // phase boundary lands in.
    thrustCoordSec +=
      0.5 * (previousThrottle + snapshot.throttle) * (snapshot.simTimeSec - previousSimTimeSec);
    previousSimTimeSec = snapshot.simTimeSec;
    if (!Number.isFinite(profileEnergySpentJ) && director.phase === 'insert') {
      profileEnergySpentJ = snapshot.energySpentJ - baselineEnergyJ;
    }
    if (snapshot.speedFractionOfLight > peakBeta) peakBeta = snapshot.speedFractionOfLight;
    if (snapshot.effectiveWarp > maxWarp) maxWarp = snapshot.effectiveWarp;
    if (abortFrame >= 0 && decompressedFrame < 0 && snapshot.requestedWarp <= 100) {
      decompressedFrame = frames;
    }
    if (snapshot.impactOccurred === 1) break;
  }

  if (targetIndex >= 0) relativeStateInto(snapshot, targetIndex, relPosition, relVelocity);
  const muKm3S2 = targetIndex >= 0 ? (catalog.muKm3S2[targetIndex] as number) : Number.NaN;
  const radiusKm = Math.hypot(
    relPosition[0] as number,
    relPosition[1] as number,
    relPosition[2] as number,
  );
  const relativeSpeedKmS = Math.hypot(
    relVelocity[0] as number,
    relVelocity[1] as number,
    relVelocity[2] as number,
  );
  const speedOfLightMS = SPEED_OF_LIGHT_KM_S * 1_000;
  const gammaPeak = 1 / Math.sqrt(1 - peakBeta * peakBeta);
  const kineticBoundJ = 2 * (gammaPeak - 1) * vessel.restMassKg * speedOfLightMS * speedOfLightMS;
  const energySpentJ = snapshot.energySpentJ - baselineEnergyJ;
  const photonPerCoordSecJ = vessel.restMassKg * vessel.alphaMaxMS2 * speedOfLightMS;
  const profilePhotonEnergyJ = photonPerCoordSecJ * director.profileCoordSec;
  const ledgerEnergyJ = photonPerCoordSecJ * thrustCoordSec;
  const controllable =
    Number.isFinite(snapshot.shipState[0] as number) &&
    Number.isFinite(snapshot.shipCoordinateVelocityKmS[0] as number) &&
    Number.isFinite(relativisticStopDistanceKm(relativeSpeedKmS, vessel.alphaMaxMS2)) &&
    snapshot.impactOccurred === 0;

  return {
    engaged,
    phase: director.phase,
    frames,
    wallSec: frames * frameDtSec,
    simTimeSec: snapshot.simTimeSec,
    properTimeSec: snapshot.shipState[STATE_TAU] as number,
    eccentricity: osculatingEccentricity(relPosition, relVelocity, muKm3S2),
    radiusKm,
    arrivalRadiusKm: presetRadiusKm,
    altitudeKm: radiusKm - collisionRadiusKm,
    presetAltitudeKm: presetRadiusKm - collisionRadiusKm,
    relativeSpeedKmS,
    energySpentJ,
    profileEnergySpentJ,
    profilePhotonEnergyJ,
    profileEnergyRatio:
      profilePhotonEnergyJ > 0 ? profileEnergySpentJ / profilePhotonEnergyJ : Number.NaN,
    thrustCoordSec,
    ledgerIdentityRatio: ledgerEnergyJ > 0 ? energySpentJ / ledgerEnergyJ : Number.NaN,
    kineticBoundJ,
    analyticEnergyJ: kineticBoundJ,
    energyRatio: kineticBoundJ > 0 ? energySpentJ / kineticBoundJ : Number.NaN,
    peakBeta,
    maxWarp,
    resolveFailures: director.resolveFailures,
    impactOccurred: snapshot.impactOccurred === 1,
    finalWarp: snapshot.requestedWarp,
    finalThrottle: snapshot.throttle,
    finalAttitudeMode: snapshot.attitudeMode,
    decompressionWallSec:
      decompressedFrame >= 0 ? (decompressedFrame - abortFrame) * frameDtSec : 0,
    controllable,
  };
}
