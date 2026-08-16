// v2 plan §2/§3.3 and physics-spec §8 — the point-and-fly cruise autopilot.
//
// Game layer only: it drives the existing `Commands` surface and nothing else,
// so cruise energy is the integrator's ledger by construction (design §6).
// Design doc: docs/superpowers/specs/2026-08-16-cruise-director-design.md.

import { SPEED_OF_LIGHT_KM_S } from '../../core/constants.js';
import { MANUAL_ATTITUDE_MAX_WARP, MAX_THRUST_WARP } from '../../core/time.js';
import {
  relativisticStopCoordSec,
  relativisticStopDistanceKm,
} from '../../sim/guidance/brakingEnvelope.js';
import {
  brachistochroneHalfCoordSec,
  createCompiledRails,
  createInterceptSolution,
  ORBIT_ARRIVAL_RADIUS_FACTOR,
  solveInterceptInto,
  type ArrivalIntent,
  type CompiledRails,
  type InterceptSolution,
} from '../../sim/guidance/constantAccelIntercept.js';
import { evaluateRailsInto, type CompiledRailsCatalog } from '../../sim/propagation/rails.js';
import { writeForwardFromQuaternionInto } from '../../sim/ship/attitude.js';
import type { VesselConfig } from '../../sim/ship/vessel.js';
import { validateVesselConfig } from '../../sim/ship/vessel.js';
import { WarningFlag, type Commands, type SimSnapshot } from '../../sim/simulationSnapshot.js';

import { orbitArrivalAltitudeKm } from './arrivalStandoff.js';
import {
  circularSpeedKmS,
  osculatingEccentricity,
  writeEclipticTangentInto,
  writeOsculatingTangentInto,
} from './cruiseInsertion.js';
import { CruiseWarpPilot, DECOMPRESSED_WARP } from './cruiseWarpPilot.js';
import type { FlightController } from './flightController.js';

/** Plan §2 phase vocabulary. `align` and `flip` are the two slew phases. */
export type CruisePhase =
  'idle' | 'align' | 'boost' | 'flip' | 'brake' | 'insert' | 'done' | 'aborted';

/**
 * Which guidance law is flying, orthogonal to the phase (design §2).
 *
 * `profile` flies the §8.4 solve open loop; `pursuit` is physics-spec §8.7,
 * which needs no time of flight and is therefore always available — the
 * endgame, the fallback for `ok = false`, and the abort-resume mode.
 */
export type CruiseGuidanceMode = 'profile' | 'pursuit';

/** Sub-state of the `insert` phase; see design §4.3. */
export type CruiseInsertStage = 'kill' | 'circularize' | 'trim';

/** Attitude error above which a thrust phase cuts throttle and slews (2°). */
export const ALIGN_ENTER_RAD = 0.034_906_585;

/**
 * Attitude error below which `align`/`flip` hand back to the thrust phase (0.5°).
 *
 * Not the same number as {@link SLEW_SETTLE_RAD}: a pursuit aim moves while the
 * ship coasts, so an exit test at the settle threshold is a slew chasing its own
 * tail — the endgame spent 39% of its frames unpowered in `align` until these
 * two were separated. Leaving at 0.5° resumes thrust and lets the remaining
 * error close under power.
 */
export const ALIGN_EXIT_RAD = 0.008_726_646;

/** Attitude error below which rotation stops being commanded at all. */
export const SLEW_SETTLE_RAD = 1e-3;

/** Attitude error above which a settled phase resumes slewing (0.57°, hysteresis). */
export const REAIM_RAD = 0.01;

/** Mid-course re-solve cadence, in simulated seconds (plan §3.3.4). */
export const MID_COURSE_RESOLVE_SEC = 300;

/** Simulated seconds between lateral-drift evaluations of the flown profile. */
export const DRIFT_CHECK_SEC = 30;

/** Lateral drift, as a fraction of remaining distance, that forces a re-solve. */
export const LATERAL_DRIFT_FRACTION = 0.005;

/**
 * Fraction of the trip during which mid-course re-solves are adopted.
 *
 * A re-solve arrives at rest in the drift frame *it* was taken in (§8.4), so the
 * arrival residual the insert phase must remove is `|v(t_solve) − v_target|` —
 * which grows with every second of boost already flown. The kappa guard admits
 * anything up to 10% of the profile's peak celerity, and on the Mars route a
 * re-solve accepted at the flip leaves 535 km/s instead of the 63.5 km/s a
 * departure solve leaves. The gravity error the re-solve exists to absorb is
 * concentrated at departure (physics-spec §8.7 measures ~3 km/s of it while the
 * ship is still near LEO), so the window is the leading tenth of the trip.
 */
export const MID_COURSE_WINDOW_FRACTION = 0.1;

/** physics-spec §8.7 — brake when `d_rel <= 1.2 D_stop`; §8.3 warns at 1.5. */
export const PURSUIT_BRAKE_MARGIN = 1.2;
export const COLLISION_WARNING_MARGIN = 1.5;

/** physics-spec §8.7 — pursuit settles below this relative speed. */
export const PURSUIT_SETTLE_KM_S = 1e-3;

/** Arrival radius tolerance, as a fraction of the stand-off radius. */
export const ARRIVAL_RADIUS_TOLERANCE = 0.01;

/**
 * Rails-relative rest tolerance for handing over to circularization, as a
 * fraction of the local circular speed.
 *
 * physics-spec §8.7's own settle is an absolute 1e-3 km/s, which the endgame
 * cannot reach while warped: the target's gravity adds `g·dt` of velocity every
 * frame — 0.02 km/s per frame at Jupiter's stand-off at 1000x — so an absolute
 * threshold is a limit cycle rather than a stop. Both circularization burns are
 * computed from the live state, so what "rest" has to mean here is "small
 * against the orbit being entered": 2% of `v_circ` bounds the eccentricity it
 * contributes at 0.02, inside the 0.05 acceptance on its own and removed by the
 * trim burn anyway.
 */
export const INSERT_REST_FRACTION = 0.02;

/** Residual along a held burn axis below which the burn is complete. */
export const BURN_SETTLE_KM_S = 1e-4;

/** Eccentricity the insertion trims to, and how many trims it is allowed. */
export const CIRCULAR_ECCENTRICITY_TARGET = 0.02;
export const MAX_TRIM_BURNS = 2;

/**
 * Collision radii of a non-target dominant body inside which the aim is held
 * above the local horizon.
 *
 * physics-spec §8.4 is a thrust-only model: it neither knows nor cares that the
 * straight line from a 400 km LEO to Mars at J2026 passes through the Earth. At
 * 10 g the profile's own axis reaches the surface in 96 s.
 */
export const DEPARTURE_CLEARANCE_RADII = 4;

/** Minimum elevation above the local horizon while inside the clearance radius. */
export const MIN_DEPARTURE_ELEVATION_RAD = 0.261_799_388;

/** Frames the warp pilot keeps in hand for the manoeuvre currently running. */
export const MIN_MANOEUVRE_FRAMES = 8;

/** Largest wall step `update` integrates in one call, matching FlightController. */
const MAX_UPDATE_DT_SEC = 0.1;

export interface CruiseDirectorPorts {
  readonly commands: Commands;
  /** The simulation's currently published snapshot; never retained. */
  snapshot(): SimSnapshot;
  /** The vessel in force for this session — `SimulationCore.vessel`. */
  readonly vessel: VesselConfig;
  /** The compiled catalog the simulation runs on; guidance gets its own scratch. */
  readonly catalog: CompiledRailsCatalog;
  /** Released back to the player on abort/arrival (design §1.2). */
  readonly controller: FlightController;
}

function unitInto(out: Float64Array, x: number, y: number, z: number): boolean {
  const magnitude = Math.hypot(x, y, z);
  if (!(magnitude > 0) || !Number.isFinite(magnitude)) return false;
  out[0] = x / magnitude;
  out[1] = y / magnitude;
  out[2] = z / magnitude;
  return true;
}

/**
 * physics-spec §8.5 — the stand-off the solver itself would resolve, recomputed
 * here because pursuit mode has no `InterceptSolution` to read it from.
 */
function resolveArrivalRadiusKm(
  collisionRadiusKm: number,
  arrival: ArrivalIntent,
  arrivalAltitudeKm: number,
): number {
  if (!Number.isFinite(arrivalAltitudeKm) || arrivalAltitudeKm < 0) return Number.NaN;
  if (arrivalAltitudeKm > 0)
    return Math.max(collisionRadiusKm, collisionRadiusKm + arrivalAltitudeKm);
  if (!(collisionRadiusKm > 0)) return Number.NaN;
  return arrival === 'orbit' ? ORBIT_ARRIVAL_RADIUS_FACTOR * collisionRadiusKm : collisionRadiusKm;
}

/**
 * Engage a body, arrive in a stable orbit, unattended.
 *
 * `update()` is allocation-free; every vector below is preallocated and the
 * rails handle is the guidance-owned scratch from `createCompiledRails`, never
 * `SimulationCore`'s live `RailsState` (ADR-037 §6).
 */
export class CruiseDirector {
  private readonly ports: CruiseDirectorPorts;
  private readonly rails: CompiledRails;
  private readonly solution: InterceptSolution = createInterceptSolution();
  private readonly warpPilot = new CruiseWarpPilot();
  private alphaMaxMS2: number;
  private maxSlewRadPerSimS: number;

  private phaseState: CruisePhase = 'idle';
  private modeState: CruiseGuidanceMode = 'pursuit';
  private insertStage: CruiseInsertStage = 'kill';
  private resumePhase: CruisePhase = 'boost';
  private targetIndex = -1;
  private targetIdState: string | null = null;
  private arrivalIntent: ArrivalIntent = 'orbit';
  private arrivalAltitudeKmState = 0;
  private arrivalRadiusKmState = Number.NaN;
  private flipStartSimSec = Number.NaN;
  private arrivalSimSec = Number.NaN;
  private lastResolveSimSec = Number.NaN;
  private engageSimSec = Number.NaN;
  private profileProperRatio = 1;
  private profileCoordSecState = Number.NaN;
  private profilePeakBetaState = Number.NaN;
  private lastDriftCheckSimSec = Number.NaN;
  private lastDominantBodyIndex = -1;
  private trimCount = 0;
  private pursuitBraking = false;
  private pursuitDeltaVKmS = 0;
  private pursuitClosingKmS = 0;
  private pursuitApproachKmS = 0;
  private resolveFailureCount = 0;
  private decompressPending = false;
  private slewing = false;
  private etaCoordSecState = 0;
  private etaProperSecState = 0;
  private eccentricityState = Number.NaN;

  private readonly aim = new Float64Array(3);
  private readonly desiredAim = new Float64Array(3);
  /**
   * The adopted boost axis.
   *
   * A copy, not a view on `solution.aimUnit`: a rejected solve zeroes every field
   * of the record it was handed (physics-spec §8.6), so reading the axis straight
   * out of `this.solution` would silently replace the flown profile's thrust axis
   * with `(0,0,0)` the first time a mid-cruise re-solve was refused — and a zero
   * aim reads back as an attitude error of exactly zero, i.e. "aligned".
   */
  private readonly profileAxis = new Float64Array(3);
  private readonly nose = new Float64Array(3);
  private readonly relPositionKm = new Float64Array(3);
  private readonly relVelocityKmS = new Float64Array(3);
  private readonly pursuitDeltaV = new Float64Array(3);
  private readonly burnAxis = new Float64Array(3);
  private readonly burnTargetVelocityKmS = new Float64Array(3);
  private readonly tangent = new Float64Array(3);
  private readonly bodyRate = new Float64Array(3);
  private readonly clearanceRadial = new Float64Array(3);
  private readonly clearanceTangent = new Float64Array(3);

  constructor(ports: CruiseDirectorPorts) {
    this.ports = ports;
    this.rails = createCompiledRails(ports.catalog);
    const vessel = validateVesselConfig(ports.vessel);
    this.alphaMaxMS2 = vessel.alphaMaxMS2;
    this.maxSlewRadPerSimS = vessel.maxSlewRadPerSimS;
  }

  get phase(): CruisePhase {
    return this.phaseState;
  }

  get guidanceMode(): CruiseGuidanceMode {
    return this.modeState;
  }

  get insertionStage(): CruiseInsertStage {
    return this.insertStage;
  }

  /** True while the director owns attitude and throttle (frame-loop arbitration). */
  get active(): boolean {
    const phase = this.phaseState;
    return (
      phase === 'align' ||
      phase === 'boost' ||
      phase === 'flip' ||
      phase === 'brake' ||
      phase === 'insert'
    );
  }

  get targetBodyId(): string | null {
    return this.targetIdState;
  }

  get arrivalRadiusKm(): number {
    return this.arrivalRadiusKmState;
  }

  /** Coordinate seconds to arrival; 0 when not engaged. */
  get etaCoordSec(): number {
    return this.etaCoordSecState;
  }

  /** Ship proper seconds to arrival; 0 when not engaged. */
  get etaProperSec(): number {
    return this.etaProperSecState;
  }

  /** Coordinate time of flight of the adopted §8.4 profile; NaN in pursuit mode. */
  get profileCoordSec(): number {
    return this.profileCoordSecState;
  }

  /** `peakBeta` of the adopted profile; NaN in pursuit mode. */
  get profilePeakBeta(): number {
    return this.profilePeakBetaState;
  }

  /** Rate at which the stand-off distance is closing, km/s (HUD + gates). */
  get closingSpeedKmS(): number {
    return this.pursuitClosingKmS;
  }

  /** Largest closing speed the endgame may hold at this distance, km/s. */
  get approachSpeedLimitKmS(): number {
    return this.pursuitApproachKmS;
  }

  /** Magnitude of the outstanding pursuit command, km/s. */
  get pursuitCommandKmS(): number {
    return this.pursuitDeltaVKmS;
  }

  /** Osculating eccentricity achieved by insertion; NaN until it is measured. */
  get achievedEccentricity(): number {
    return this.eccentricityState;
  }

  /** Mid-course solves that returned `ok = false` — a routing statistic, not errors. */
  get resolveFailures(): number {
    return this.resolveFailureCount;
  }

  /** Re-reads the session vessel after a restore replaced the simulation (ADR-034 §4). */
  setVessel(vessel: VesselConfig): void {
    const validated = validateVesselConfig(vessel);
    this.alphaMaxMS2 = validated.alphaMaxMS2;
    this.maxSlewRadPerSimS = validated.maxSlewRadPerSimS;
  }

  /**
   * Engages cruise to `targetBodyId`. Returns false when the body is unknown or
   * no stand-off can be resolved; a failed §8.4 solve is *not* a failure to
   * engage — it selects pursuit (design §2).
   */
  engage(
    targetBodyId: string,
    arrival: ArrivalIntent = 'orbit',
    arrivalAltitudeKm?: number,
  ): boolean {
    const catalog = this.ports.catalog;
    const index = catalog.bodyIds.indexOf(targetBodyId);
    if (index < 0) return false;
    const collisionRadiusKm = catalog.collisionRadiiKm[index] as number;
    const altitudeKm =
      arrivalAltitudeKm !== undefined && Number.isFinite(arrivalAltitudeKm) && arrivalAltitudeKm > 0
        ? arrivalAltitudeKm
        : arrival === 'orbit'
          ? orbitArrivalAltitudeKm(targetBodyId, collisionRadiusKm)
          : 0;
    const radiusKm = resolveArrivalRadiusKm(collisionRadiusKm, arrival, altitudeKm);
    if (!Number.isFinite(radiusKm)) return false;

    const snapshot = this.ports.snapshot();
    if (snapshot.impactOccurred === 1) return false;
    this.targetIndex = index;
    this.targetIdState = targetBodyId;
    this.arrivalIntent = arrival;
    this.arrivalAltitudeKmState = altitudeKm;
    this.arrivalRadiusKmState = radiusKm;
    this.insertStage = 'kill';
    this.trimCount = 0;
    this.pursuitBraking = false;
    this.resolveFailureCount = 0;
    this.eccentricityState = Number.NaN;
    this.lastDominantBodyIndex = snapshot.dominantBodyIndex;
    this.engageSimSec = snapshot.simTimeSec;
    this.decompressPending = false;
    this.slewing = true;
    this.ports.commands.setTarget(targetBodyId);
    this.ports.controller.setThrustRegime('cruise');
    this.warpPilot.engage(snapshot);
    this.modeState = this.solve(snapshot) ? 'profile' : 'pursuit';
    this.enterAlign('boost');
    return true;
  }

  /**
   * Any player input while cruise is engaged (design §4.3: "touching the stick
   * ... pauses cruise"). Decompresses and hands the ship back; `engage()` is the
   * documented resume, and resumes in pursuit mode when the solve refuses.
   */
  notifyPlayerInput(): void {
    this.warpPilot.triggerDecompression();
    if (this.active) this.finish('aborted');
  }

  /** Hands the ship back to the player; decompression continues until <= 100x. */
  abort(): void {
    if (this.phaseState === 'idle') return;
    this.finish('aborted');
  }

  /**
   * One frame of cruise. Safe (and required) to call when idle: an aborted or
   * completed cruise keeps piloting the warp down until it is back at <= 100x.
   */
  update(wallDtSec: number): void {
    const dtWallSec =
      Number.isFinite(wallDtSec) && wallDtSec > 0 ? Math.min(wallDtSec, MAX_UPDATE_DT_SEC) : 0;
    const snapshot = this.ports.snapshot();
    if (!this.active) {
      if (!this.decompressPending) return;
      this.warpPilot.update(dtWallSec, DECOMPRESSED_WARP, snapshot, this.ports.commands);
      if (snapshot.requestedWarp <= DECOMPRESSED_WARP) {
        this.warpPilot.release();
        this.decompressPending = false;
      }
      return;
    }
    if (snapshot.impactOccurred === 1) {
      this.finish('aborted');
      return;
    }

    this.observeSafety(snapshot);
    this.readRelativeState(snapshot);
    const manoeuvreSimSec = this.advancePhase(snapshot);
    const errorRad = this.attitudeErrorRad(snapshot);
    this.slewing = this.slewing ? errorRad > SLEW_SETTLE_RAD : errorRad > REAIM_RAD;
    // Warp first, then attitude: the slew rate is a *simulated* rate, so it has
    // to be sized against the step the next `step()` will actually take. Sizing
    // it against the previous frame's tier let a 50x -> 1000x ramp overshoot the
    // aim by twentyfold, which read back as a 2 deg error and chattered the
    // align phase against every thrust phase.
    this.warpPilot.update(
      dtWallSec,
      this.warpCeiling(dtWallSec, manoeuvreSimSec),
      snapshot,
      this.ports.commands,
    );
    const warp = Math.max(this.warpPilot.requestedWarp, snapshot.effectiveWarp);
    this.commandShip(
      snapshot,
      errorRad,
      dtWallSec * (warp > 0 ? warp : 1),
      this.warpPilot.requestedWarp,
    );
  }

  /** Decompression triggers: SOI change, warning flags, collision course (design §5). */
  private observeSafety(snapshot: SimSnapshot): void {
    if (snapshot.dominantBodyIndex !== this.lastDominantBodyIndex) {
      this.lastDominantBodyIndex = snapshot.dominantBodyIndex;
      this.engageSimSec = snapshot.simTimeSec;
      this.warpPilot.triggerDecompression();
    }
    const watched = WarningFlag.SOI_CHANGE | WarningFlag.ATMOSPHERE_ENTRY | WarningFlag.IMPACT;
    if ((snapshot.warningFlags & watched) !== 0) this.warpPilot.triggerDecompression();
    if (this.collisionCourse(snapshot)) this.warpPilot.triggerDecompression();
  }

  /** physics-spec §8.3 — `altitude < 1.5 D_stop(closing speed)` against the dominant body. */
  private collisionCourse(snapshot: SimSnapshot): boolean {
    const index = snapshot.dominantBodyIndex;
    if (index < 0) return false;
    if (index === this.targetIndex && this.phaseState === 'insert') return false;
    const offset = index * 3;
    const dx = (snapshot.shipState[0] as number) - (snapshot.bodyPositionsKm[offset] as number);
    const dy = (snapshot.shipState[1] as number) - (snapshot.bodyPositionsKm[offset + 1] as number);
    const dz = (snapshot.shipState[2] as number) - (snapshot.bodyPositionsKm[offset + 2] as number);
    const distanceKm = Math.hypot(dx, dy, dz);
    if (!(distanceKm > 0)) return false;
    const vx =
      (snapshot.shipCoordinateVelocityKmS[0] as number) -
      (snapshot.bodyVelocitiesKmS[offset] as number);
    const vy =
      (snapshot.shipCoordinateVelocityKmS[1] as number) -
      (snapshot.bodyVelocitiesKmS[offset + 1] as number);
    const vz =
      (snapshot.shipCoordinateVelocityKmS[2] as number) -
      (snapshot.bodyVelocitiesKmS[offset + 2] as number);
    const closingKmS = -(vx * dx + vy * dy + vz * dz) / distanceKm;
    if (!(closingKmS > 0)) return false;
    const collisionRadiusKm = this.ports.catalog.collisionRadiiKm[index] as number;
    // Impact parameter of the straight-line path, |r x v|/|v|. Without it the
    // test degenerates into "cannot stop before the body", which for a torchship
    // is true of the Sun for most of an interplanetary cruise (D_stop at 5,900
    // km/s is 1.2 AU) and would pin the warp at 100x for the whole flight.
    const speedKmS = Math.hypot(vx, vy, vz);
    if (!(speedKmS > 0)) return false;
    const missKm = Math.hypot(dy * vz - dz * vy, dz * vx - dx * vz, dx * vy - dy * vx) / speedKmS;
    if (missKm > collisionRadiusKm) return false;
    const altitudeKm = distanceKm - collisionRadiusKm;
    return (
      altitudeKm <
      COLLISION_WARNING_MARGIN * relativisticStopDistanceKm(closingKmS, this.alphaMaxMS2)
    );
  }

  /** Target-relative distance, allocation-free (no spread into `Math.hypot`). */
  private relDistanceKm(): number {
    return Math.hypot(
      this.relPositionKm[0] as number,
      this.relPositionKm[1] as number,
      this.relPositionKm[2] as number,
    );
  }

  private relSpeedKmS(): number {
    return Math.hypot(
      this.relVelocityKmS[0] as number,
      this.relVelocityKmS[1] as number,
      this.relVelocityKmS[2] as number,
    );
  }

  private readRelativeState(snapshot: SimSnapshot): void {
    const offset = this.targetIndex * 3;
    for (let axis = 0; axis < 3; axis += 1) {
      this.relPositionKm[axis] =
        (snapshot.shipState[axis] as number) - (snapshot.bodyPositionsKm[offset + axis] as number);
      this.relVelocityKmS[axis] =
        (snapshot.shipCoordinateVelocityKmS[axis] as number) -
        (snapshot.bodyVelocitiesKmS[offset + axis] as number);
    }
  }

  /**
   * Runs the §8.4 solve and adopts the schedule it produces.
   *
   * Returns false for `ok = false`, which is a routing decision and not an error
   * (ADR-037 §4): nothing already adopted is disturbed.
   */
  private solve(snapshot: SimSnapshot): boolean {
    solveInterceptInto(
      this.solution,
      snapshot.shipState,
      this.rails,
      this.targetIndex,
      this.alphaMaxMS2,
      this.arrivalIntent,
      this.arrivalAltitudeKmState,
      snapshot.simTimeSec,
    );
    this.lastResolveSimSec = snapshot.simTimeSec;
    this.lastDriftCheckSimSec = snapshot.simTimeSec;
    if (!this.solution.ok) {
      this.resolveFailureCount += 1;
      return false;
    }
    this.modeState = 'profile';
    this.arrivalRadiusKmState = this.solution.arrivalRadiusKm;
    const slewBudgetSec = Math.PI / this.maxSlewRadPerSimS;
    this.flipStartSimSec = snapshot.simTimeSec + this.solution.flipAtCoordSec - 0.5 * slewBudgetSec;
    this.arrivalSimSec = snapshot.simTimeSec + this.solution.totalCoordSec;
    this.profileProperRatio =
      this.solution.totalCoordSec > 0
        ? this.solution.totalProperSec / this.solution.totalCoordSec
        : 1;
    this.profileCoordSecState = this.solution.totalCoordSec;
    this.profilePeakBetaState = this.solution.peakBeta;
    this.profileAxis.set(this.solution.aimUnit);
    this.aim.set(this.profileAxis);
    this.desiredAim.set(this.profileAxis);
    return true;
  }

  /**
   * Advances the phase machine and returns the simulated seconds the current
   * manoeuvre still has to run (the warp bound of design §5).
   */
  private advancePhase(snapshot: SimSnapshot): number {
    const alphaKmS2 = this.alphaMaxMS2 / 1_000;
    const standoffDistanceKm = this.relDistanceKm() - this.arrivalRadiusKmState;
    const relSpeedKmS = this.relSpeedKmS();
    this.writePursuitCommand(standoffDistanceKm);

    if (this.phaseState === 'align') {
      this.writeAimFor(this.resumePhase, snapshot);
      if (this.attitudeErrorRad(snapshot) <= ALIGN_EXIT_RAD) this.phaseState = this.resumePhase;
      return Math.PI / this.maxSlewRadPerSimS;
    }

    if (this.phaseState === 'flip') {
      this.writeAimFor('brake', snapshot);
      if (this.attitudeErrorRad(snapshot) <= ALIGN_EXIT_RAD) {
        this.phaseState = 'brake';
        this.lastResolveSimSec = snapshot.simTimeSec;
      }
      return Math.PI / this.maxSlewRadPerSimS;
    }

    if (this.phaseState === 'boost') {
      if (this.modeState === 'profile') {
        if (snapshot.simTimeSec >= this.flipStartSimSec) {
          this.phaseState = 'flip';
          this.writeAimFor('brake', snapshot);
          return Math.PI / this.maxSlewRadPerSimS;
        }
        this.maybeResolve(snapshot);
        this.writeAimFor('boost', snapshot);
        this.updateEta(snapshot, standoffDistanceKm, relSpeedKmS);
        return Math.max(1, this.flipStartSimSec - snapshot.simTimeSec);
      }
      // Pursuit: `boost` is the closing branch of §8.7.
      this.writeAimFor('boost', snapshot);
      this.updateEta(snapshot, standoffDistanceKm, relSpeedKmS);
      if (this.pursuitBraking) this.phaseState = 'brake';
      return Math.max(
        1,
        2 * brachistochroneHalfCoordSec(Math.abs(standoffDistanceKm), this.alphaMaxMS2),
      );
    }

    if (this.phaseState === 'brake') {
      this.writeAimFor('brake', snapshot);
      this.updateEta(snapshot, standoffDistanceKm, relSpeedKmS);
      // Ends on the *state*, not on the clock. The profile's schedule assumes an
      // uninterrupted burn, and align, flip and warp clamps cost it a few per
      // cent of thrust time; on the Mars route that left 521 km/s of closing
      // speed at `arrivalSimSec` and the ship simply flew past. The pursuit
      // criterion — no longer over-speed for the distance still to run — is the
      // physically correct handover, and the clock only bounds the warp.
      if (!this.pursuitBraking || standoffDistanceKm <= 0) {
        this.phaseState = 'insert';
        this.insertStage = 'kill';
      }
      return Math.max(
        1,
        relativisticStopCoordSec(
          Math.max(0, this.pursuitClosingKmS - this.pursuitApproachKmS),
          this.alphaMaxMS2,
        ),
      );
    }

    // insert
    this.updateEta(snapshot, standoffDistanceKm, relSpeedKmS);
    if (this.insertStage === 'kill') {
      this.writeAimFor('insert', snapshot);
      const restToleranceKmS = Math.max(
        PURSUIT_SETTLE_KM_S,
        INSERT_REST_FRACTION *
          circularSpeedKmS(
            this.ports.catalog.muKm3S2[this.targetIndex] as number,
            this.relDistanceKm(),
          ),
      );
      const settled =
        this.pursuitDeltaVKmS <= restToleranceKmS &&
        Math.abs(standoffDistanceKm) <= ARRIVAL_RADIUS_TOLERANCE * this.arrivalRadiusKmState;
      if (settled) this.beginCircularization(false);
      return Math.max(
        1,
        Math.min(
          relativisticStopCoordSec(relSpeedKmS, this.alphaMaxMS2),
          2 * brachistochroneHalfCoordSec(Math.abs(standoffDistanceKm), this.alphaMaxMS2),
        ),
      );
    }
    const remainingKmS = this.burnResidualKmS();
    this.aim.set(this.burnAxis);
    this.desiredAim.set(this.burnAxis);
    if (remainingKmS <= BURN_SETTLE_KM_S) {
      if (this.insertStage === 'circularize') {
        this.beginCircularization(true);
      } else {
        this.eccentricityState = osculatingEccentricity(
          this.relPositionKm,
          this.relVelocityKmS,
          this.ports.catalog.muKm3S2[this.targetIndex] as number,
        );
        if (
          this.eccentricityState <= CIRCULAR_ECCENTRICITY_TARGET ||
          this.trimCount >= MAX_TRIM_BURNS
        ) {
          this.finish('done');
          return 1;
        }
        this.trimCount += 1;
        this.beginCircularization(true);
      }
    }
    return Math.max(1, remainingKmS / alphaKmS2);
  }

  /**
   * physics-spec §8.7 as amended by ADR-043 — the rendezvous form of the pursuit
   * rule, which replaces its two aim branches with one continuous law.
   *
   * Desired relative velocity: close the stand-off at exactly the speed whose
   * §8.3 stop distance is `|d_rel| / 1.2`, i.e. the spec's own brake margin read
   * as a speed instead of a switch. `Δv = v_des − v_rel` is then the whole
   * command: its direction is the aim, its magnitude is the throttle, and the
   * spec's "close" and "brake" branches are its two limits — at rest it points
   * at the target, and too fast it points along `−v̂_rel`.
   *
   * The literal two-branch rule does not fly. Its closing aim
   * `unit(r_j(t + t_lead) − r(t))` is evaluated in the heliocentric frame while
   * the ship it is handed by §8.4 is *co-moving with the target* at up to 30
   * km/s, so a 90 s lead points 2,700 km wide of a 200 km approach; and adding
   * §8.4's drift term to repair that makes the aim reverse the moment
   * `v·t_lead` exceeds `d_rel`, which is exactly where the brake switch lives.
   * Measured on the LEO→Mars route: 1,746 branch flips, 39% of the endgame's
   * frames spent unpowered in `align`, and no arrival.
   */
  private writePursuitCommand(standoffDistanceKm: number): void {
    const distanceKm = this.relDistanceKm();
    const approachKmS = this.speedForStopDistanceKmS(
      Math.abs(standoffDistanceKm) / PURSUIT_BRAKE_MARGIN,
    );
    const sign = standoffDistanceKm >= 0 ? 1 : -1;
    const scale = distanceKm > 0 ? (-sign * approachKmS) / distanceKm : 0;
    let closingKmS = 0;
    for (let axis = 0; axis < 3; axis += 1) {
      const desiredKmS = scale * (this.relPositionKm[axis] as number);
      this.pursuitDeltaV[axis] = desiredKmS - (this.relVelocityKmS[axis] as number);
      if (distanceKm > 0) {
        closingKmS +=
          (-sign * (this.relVelocityKmS[axis] as number) * (this.relPositionKm[axis] as number)) /
          distanceKm;
      }
    }
    this.pursuitDeltaVKmS = Math.hypot(
      this.pursuitDeltaV[0] as number,
      this.pursuitDeltaV[1] as number,
      this.pursuitDeltaV[2] as number,
    );
    this.pursuitClosingKmS = closingKmS;
    this.pursuitApproachKmS = approachKmS;
    this.pursuitBraking = closingKmS > approachKmS;
  }

  /**
   * physics-spec §8.3 inverted: the relative speed whose exact stop distance is
   * `distanceKm`. `gamma = 1 + alpha d / c^2`, then `v = c sqrt(1 - 1/gamma^2)`;
   * degrades to the Newtonian `sqrt(2 alpha d)` for shallow approaches.
   */
  private speedForStopDistanceKmS(distanceKm: number): number {
    if (!(distanceKm > 0)) return 0;
    const alphaKmS2 = this.alphaMaxMS2 / 1_000;
    const gamma = 1 + (alphaKmS2 * distanceKm) / (SPEED_OF_LIGHT_KM_S * SPEED_OF_LIGHT_KM_S);
    const beta = Math.sqrt(Math.max(0, 1 - 1 / (gamma * gamma)));
    return beta * SPEED_OF_LIGHT_KM_S;
  }

  /** Starts burn 1 (`trim = false`) or burn 2 (`trim = true`) — design §4.3. */
  private beginCircularization(trim: boolean): void {
    const muKm3S2 = this.ports.catalog.muKm3S2[this.targetIndex] as number;
    const radiusKm = this.relDistanceKm();
    const circularKmS = circularSpeedKmS(muKm3S2, radiusKm);
    if (trim) writeOsculatingTangentInto(this.tangent, this.relPositionKm, this.relVelocityKmS);
    else writeEclipticTangentInto(this.tangent, this.relPositionKm);
    for (let axis = 0; axis < 3; axis += 1) {
      this.burnTargetVelocityKmS[axis] = circularKmS * (this.tangent[axis] as number);
    }
    const dx = (this.burnTargetVelocityKmS[0] as number) - (this.relVelocityKmS[0] as number);
    const dy = (this.burnTargetVelocityKmS[1] as number) - (this.relVelocityKmS[1] as number);
    const dz = (this.burnTargetVelocityKmS[2] as number) - (this.relVelocityKmS[2] as number);
    if (!unitInto(this.burnAxis, dx, dy, dz)) {
      this.finish('done');
      return;
    }
    this.insertStage = trim ? 'trim' : 'circularize';
    this.enterAlign(this.phaseState);
  }

  /** Δv still owed along the held burn axis, measured from the live state. */
  private burnResidualKmS(): number {
    let residual = 0;
    for (let axis = 0; axis < 3; axis += 1) {
      residual +=
        ((this.burnTargetVelocityKmS[axis] as number) - (this.relVelocityKmS[axis] as number)) *
        (this.burnAxis[axis] as number);
    }
    return residual > 0 ? residual : 0;
  }

  /** Re-solve gate: cadence, or lateral drift, and only while still slow (§8.7). */
  private maybeResolve(snapshot: SimSnapshot): void {
    if (this.modeState !== 'profile') return;
    if (
      snapshot.simTimeSec - this.engageSimSec >
      MID_COURSE_WINDOW_FRACTION * this.solution.totalCoordSec
    ) {
      return;
    }
    const elapsedSec = snapshot.simTimeSec - this.lastResolveSimSec;
    let resolve = elapsedSec >= MID_COURSE_RESOLVE_SEC;
    if (!resolve && snapshot.simTimeSec - this.lastDriftCheckSimSec >= DRIFT_CHECK_SEC) {
      this.lastDriftCheckSimSec = snapshot.simTimeSec;
      resolve = this.lateralDriftExceeded(snapshot);
    }
    if (!resolve) return;
    // physics-spec §8.6/§8.7: a mid-cruise rejection is a routing decision, and
    // `solve` leaves the adopted profile untouched when it refuses. The director
    // never retries harder and never widens kappa.
    this.solve(snapshot);
  }

  /** Perpendicular offset of the aim point from the flown thrust axis (plan §3.3.4). */
  private lateralDriftExceeded(snapshot: SimSnapshot): boolean {
    if (!Number.isFinite(this.arrivalSimSec)) return false;
    evaluateRailsInto(
      this.rails.scratchState,
      this.rails.catalog,
      this.arrivalSimSec,
      this.rails.scratchWorkspace,
    );
    const offset = this.targetIndex * 3;
    // Measured in the drift frame the solve itself lives in (physics-spec §8.4):
    // `Delta = r_j(t_arr) - r(t) - v(t)*(t_arr - t)`. Without the drift term the
    // metric reports the ship's own transverse velocity — which the profile put
    // there on purpose — as error, and fires a re-solve on almost every check.
    const remainingSec = this.arrivalSimSec - snapshot.simTimeSec;
    const dx =
      (this.rails.scratchState.positionsKm[offset] as number) -
      (snapshot.shipState[0] as number) -
      (snapshot.shipCoordinateVelocityKmS[0] as number) * remainingSec;
    const dy =
      (this.rails.scratchState.positionsKm[offset + 1] as number) -
      (snapshot.shipState[1] as number) -
      (snapshot.shipCoordinateVelocityKmS[1] as number) * remainingSec;
    const dz =
      (this.rails.scratchState.positionsKm[offset + 2] as number) -
      (snapshot.shipState[2] as number) -
      (snapshot.shipCoordinateVelocityKmS[2] as number) * remainingSec;
    const remainingKm = Math.hypot(dx, dy, dz);
    if (!(remainingKm > 0)) return false;
    const along =
      dx * (this.profileAxis[0] as number) +
      dy * (this.profileAxis[1] as number) +
      dz * (this.profileAxis[2] as number);
    const lateralKm = Math.sqrt(Math.max(0, remainingKm * remainingKm - along * along));
    return lateralKm > LATERAL_DRIFT_FRACTION * remainingKm;
  }

  /**
   * Writes `this.aim` for the phase that wants to thrust.
   *
   * The departure clamp is applied here, not after the phase machine has run:
   * the align-complete test compares the nose against `this.aim`, so a clamp
   * applied downstream of that test would be an aim the ship is never allowed
   * to reach, and the director would sit in `align` for ever.
   */
  private writeAimFor(intent: CruisePhase, snapshot: SimSnapshot): void {
    this.writeGuidanceAimFor(intent);
    this.applyDepartureClearance(snapshot);
    this.commitAim();
  }

  /**
   * Deadbands the aim so a continuously moving guidance command does not pin the
   * warp at 100x for the whole endgame.
   *
   * `Commands.rotate` is forced to zero above `MANUAL_ATTITUDE_MAX_WARP`, so any
   * frame that wants to turn caps the tier. A pursuit aim moves every frame by
   * construction, which without this deadband means the entire arrival flies at
   * 100x. Holding the committed axis until the command has moved
   * {@link REAIM_RAD} lets the warp climb between corrections and self-regulates:
   * a higher tier moves the aim faster, which forces the next correction sooner.
   */
  private commitAim(): void {
    const dot =
      (this.aim[0] as number) * (this.desiredAim[0] as number) +
      (this.aim[1] as number) * (this.desiredAim[1] as number) +
      (this.aim[2] as number) * (this.desiredAim[2] as number);
    const cx =
      (this.aim[1] as number) * (this.desiredAim[2] as number) -
      (this.aim[2] as number) * (this.desiredAim[1] as number);
    const cy =
      (this.aim[2] as number) * (this.desiredAim[0] as number) -
      (this.aim[0] as number) * (this.desiredAim[2] as number);
    const cz =
      (this.aim[0] as number) * (this.desiredAim[1] as number) -
      (this.aim[1] as number) * (this.desiredAim[0] as number);
    if (Math.atan2(Math.hypot(cx, cy, cz), dot) <= REAIM_RAD) return;
    this.aim.set(this.desiredAim);
  }

  private writeGuidanceAimFor(intent: CruisePhase): void {
    if (this.modeState === 'profile' && (intent === 'boost' || intent === 'brake')) {
      const sign = intent === 'boost' ? 1 : -1;
      for (let axis = 0; axis < 3; axis += 1) {
        this.desiredAim[axis] = sign * (this.profileAxis[axis] as number);
      }
      return;
    }
    if (intent === 'insert' && this.insertStage !== 'kill') {
      this.desiredAim.set(this.burnAxis);
      return;
    }
    // physics-spec §8.7 (ADR-043): the whole command is one vector, already
    // computed for this frame. Below the burn-settle threshold its direction is
    // noise, so the attitude is held rather than chased.
    if (this.pursuitDeltaVKmS > BURN_SETTLE_KM_S) {
      unitInto(
        this.desiredAim,
        this.pursuitDeltaV[0] as number,
        this.pursuitDeltaV[1] as number,
        this.pursuitDeltaV[2] as number,
      );
    }
  }

  /**
   * Holds the aim above the local horizon while close to a non-target body.
   *
   * The guidance model drops gravity *and* geometry (physics-spec §8.4/§8.7), so
   * nothing else stops a departure burn from flying the profile axis straight
   * into the planet the ship is orbiting. The bias is a rotation of the aim
   * inside the plane it already lies in, so it costs the profile only the error
   * the mid-course re-solve exists to absorb — and it is active exactly while
   * that re-solve is still valid (early boost, physics-spec §8.6).
   */
  private applyDepartureClearance(snapshot: SimSnapshot): void {
    const index = snapshot.dominantBodyIndex;
    if (index < 0 || index === this.targetIndex) return;
    const collisionRadiusKm = this.ports.catalog.collisionRadiiKm[index] as number;
    if (!(collisionRadiusKm > 0)) return;
    const offset = index * 3;
    const rx = (snapshot.shipState[0] as number) - (snapshot.bodyPositionsKm[offset] as number);
    const ry = (snapshot.shipState[1] as number) - (snapshot.bodyPositionsKm[offset + 1] as number);
    const rz = (snapshot.shipState[2] as number) - (snapshot.bodyPositionsKm[offset + 2] as number);
    const distanceKm = Math.hypot(rx, ry, rz);
    if (!(distanceKm > 0) || distanceKm > DEPARTURE_CLEARANCE_RADII * collisionRadiusKm) return;
    if (!unitInto(this.clearanceRadial, rx, ry, rz)) return;
    const radial =
      (this.desiredAim[0] as number) * (this.clearanceRadial[0] as number) +
      (this.desiredAim[1] as number) * (this.clearanceRadial[1] as number) +
      (this.desiredAim[2] as number) * (this.clearanceRadial[2] as number);
    const minimumRadial = Math.sin(MIN_DEPARTURE_ELEVATION_RAD);
    if (radial >= minimumRadial) return;
    if (
      !unitInto(
        this.clearanceTangent,
        (this.desiredAim[0] as number) - radial * (this.clearanceRadial[0] as number),
        (this.desiredAim[1] as number) - radial * (this.clearanceRadial[1] as number),
        (this.desiredAim[2] as number) - radial * (this.clearanceRadial[2] as number),
      )
    ) {
      this.desiredAim.set(this.clearanceRadial);
      return;
    }
    const tangential = Math.cos(MIN_DEPARTURE_ELEVATION_RAD);
    for (let axis = 0; axis < 3; axis += 1) {
      this.desiredAim[axis] =
        minimumRadial * (this.clearanceRadial[axis] as number) +
        tangential * (this.clearanceTangent[axis] as number);
    }
  }

  private attitudeErrorRad(snapshot: SimSnapshot): number {
    writeForwardFromQuaternionInto(this.nose, snapshot.attitudeQuaternion);
    const dot =
      (this.nose[0] as number) * (this.aim[0] as number) +
      (this.nose[1] as number) * (this.aim[1] as number) +
      (this.nose[2] as number) * (this.aim[2] as number);
    const cx =
      (this.nose[1] as number) * (this.aim[2] as number) -
      (this.nose[2] as number) * (this.aim[1] as number);
    const cy =
      (this.nose[2] as number) * (this.aim[0] as number) -
      (this.nose[0] as number) * (this.aim[2] as number);
    const cz =
      (this.nose[0] as number) * (this.aim[1] as number) -
      (this.nose[1] as number) * (this.aim[0] as number);
    return Math.atan2(Math.hypot(cx, cy, cz), dot);
  }

  /** Switches to the slew service phase, remembering where to resume. */
  private enterAlign(resume: CruisePhase): void {
    this.resumePhase = resume === 'align' || resume === 'flip' ? 'boost' : resume;
    this.phaseState = 'align';
  }

  /**
   * Issues attitude and throttle for this frame.
   *
   * ADR-035 slew law, driven through manual rates because no `AttitudeMode` can
   * express an arbitrary inertial axis (design §1): `ω = min(maxSlewRadPerSimS,
   * θ_err/dtSim)` in **simulated** rad/s, so a 180° flip costs 12.000 s of
   * simulated time at every warp tier.
   */
  private commandShip(
    snapshot: SimSnapshot,
    errorRad: number,
    dtSimSec: number,
    requestedWarp: number,
  ): void {
    const commands = this.ports.commands;
    if (snapshot.attitudeMode !== 'manual') commands.setAttitudeMode('manual');
    if (this.phaseState !== 'align' && this.phaseState !== 'flip' && errorRad > ALIGN_ENTER_RAD) {
      this.enterAlign(this.phaseState);
    }

    if (this.slewing && requestedWarp <= MANUAL_ATTITUDE_MAX_WARP) {
      this.writeSlewRates(snapshot, errorRad, dtSimSec);
      commands.rotate(
        this.bodyRate[1] as number,
        this.bodyRate[2] as number,
        this.bodyRate[0] as number,
      );
    } else {
      commands.rotate(0, 0, 0);
    }

    commands.setThrottle(this.throttleIntent(errorRad, dtSimSec, requestedWarp));
  }

  /** Throttle for this frame, with a partial final step so burns end exactly. */
  private throttleIntent(errorRad: number, dtSimSec: number, requestedWarp: number): number {
    if (this.phaseState === 'align' || this.phaseState === 'flip') return 0;
    if (errorRad > ALIGN_ENTER_RAD) return 0;
    if (requestedWarp > MAX_THRUST_WARP) return 0;
    const alphaKmS2 = this.alphaMaxMS2 / 1_000;
    const stepKmS = alphaKmS2 * (dtSimSec > 0 ? dtSimSec : 0);
    if (!(stepKmS > 0)) return 1;
    if (this.phaseState === 'insert' && this.insertStage !== 'kill') {
      return Math.min(1, this.burnResidualKmS() / stepKmS);
    }
    if (
      this.modeState === 'pursuit' ||
      (this.phaseState === 'insert' && this.insertStage === 'kill')
    ) {
      return Math.min(1, this.pursuitDeltaVKmS / stepKmS);
    }
    return 1;
  }

  /**
   * Body-frame slew rate about the shortest-path error axis, `[roll, pitch, yaw]`.
   *
   * The axis is `nose × aim` expressed in the body frame, which has no roll
   * component by construction. Exactly antiparallel — the flip — has no such
   * axis, so a pure body pitch is used; deterministic, and 180° either way.
   */
  private writeSlewRates(snapshot: SimSnapshot, errorRad: number, dtSimSec: number): void {
    const q = snapshot.attitudeQuaternion;
    writeForwardFromQuaternionInto(this.nose, q);
    const cx =
      (this.nose[1] as number) * (this.aim[2] as number) -
      (this.nose[2] as number) * (this.aim[1] as number);
    const cy =
      (this.nose[2] as number) * (this.aim[0] as number) -
      (this.nose[0] as number) * (this.aim[2] as number);
    const cz =
      (this.nose[0] as number) * (this.aim[1] as number) -
      (this.nose[1] as number) * (this.aim[0] as number);
    const rateRadS = Math.min(
      this.maxSlewRadPerSimS,
      dtSimSec > 0 ? errorRad / dtSimSec : this.maxSlewRadPerSimS,
    );
    if (!unitInto(this.bodyRate, cx, cy, cz)) {
      this.bodyRate[0] = 0;
      this.bodyRate[1] = rateRadS;
      this.bodyRate[2] = 0;
      return;
    }
    // Inertial axis -> body axis: v_body = q^-1 * v_inertial * q.
    const qx = -(q[0] as number);
    const qy = -(q[1] as number);
    const qz = -(q[2] as number);
    const qw = q[3] as number;
    const ax = this.bodyRate[0] as number;
    const ay = this.bodyRate[1] as number;
    const az = this.bodyRate[2] as number;
    const tx = 2 * (qy * az - qz * ay);
    const ty = 2 * (qz * ax - qx * az);
    const tz = 2 * (qx * ay - qy * ax);
    this.bodyRate[0] = (ax + qw * tx + qy * tz - qz * ty) * rateRadS;
    this.bodyRate[1] = (ay + qw * ty + qz * tx - qx * tz) * rateRadS;
    this.bodyRate[2] = (az + qw * tz + qx * ty - qy * tx) * rateRadS;
  }

  /** Warp ceiling for this frame: the clamps, plus at least 8 frames per manoeuvre. */
  private warpCeiling(dtWallSec: number, manoeuvreSimSec: number): number {
    let ceiling: number = this.slewing ? MANUAL_ATTITUDE_MAX_WARP : MAX_THRUST_WARP;
    if (dtWallSec > 0 && Number.isFinite(manoeuvreSimSec) && manoeuvreSimSec > 0) {
      ceiling = Math.min(ceiling, manoeuvreSimSec / (dtWallSec * MIN_MANOEUVRE_FRAMES));
    }
    return Math.max(1, ceiling);
  }

  private updateEta(snapshot: SimSnapshot, standoffDistanceKm: number, relSpeedKmS: number): void {
    if (this.modeState === 'profile' && Number.isFinite(this.arrivalSimSec)) {
      const coordSec = Math.max(0, this.arrivalSimSec - snapshot.simTimeSec);
      this.etaCoordSecState = coordSec;
      this.etaProperSecState = coordSec * this.profileProperRatio;
      return;
    }
    const closeSec =
      2 * brachistochroneHalfCoordSec(Math.abs(standoffDistanceKm), this.alphaMaxMS2);
    const stopSec = relativisticStopCoordSec(relSpeedKmS, this.alphaMaxMS2);
    const coordSec =
      (Number.isFinite(closeSec) ? closeSec : 0) + (Number.isFinite(stopSec) ? stopSec : 0);
    this.etaCoordSecState = coordSec;
    // Pursuit runs at endgame speeds where gamma - 1 is below 1e-6; the proper
    // and coordinate estimates are the same number to the precision of either.
    this.etaProperSecState = coordSec;
  }

  /** Releases the ship to the player and leaves the warp decompressing (design §1.2). */
  private finish(phase: CruisePhase): void {
    const commands = this.ports.commands;
    commands.setThrottle(0);
    commands.rotate(0, 0, 0);
    commands.setAttitudeMode('manual');
    this.ports.controller.setThrustRegime('manual');
    this.ports.controller.resetAxes();
    this.phaseState = phase;
    this.slewing = false;
    this.etaCoordSecState = 0;
    this.etaProperSecState = 0;
    this.warpPilot.triggerDecompression();
    this.decompressPending = true;
  }
}
