import {
  MANUAL_ATTITUDE_MAX_WARP,
  MAX_THRUST_WARP,
  WARP_LADDER,
  type WarpFactor,
} from '../core/time.js';
import { RELATIVISTIC_STATE_DIMENSION } from './ship/relativity.js';

/** Stable codes explaining budget clamps or coast-only warp safety. */
export const WarpClampReason = Object.freeze({
  NONE: 0,
  INTEGRATION_BUDGET: 1,
  THRUST_LOCKOUT: 2,
} as const);

export type WarpClampReason = (typeof WarpClampReason)[keyof typeof WarpClampReason];

/** Bit flags for active flight warnings; multiple flags may be combined. */
export const WarningFlag = Object.freeze({
  NONE: 0,
  IMPACT: 1 << 0,
  ATMOSPHERE_ENTRY: 1 << 1,
  SOI_CHANGE: 1 << 2,
  ESCAPE: 1 << 3,
} as const);

/** Supported manual and automatic attitude command modes. */
export type AttitudeMode =
  | 'manual'
  | 'prograde'
  | 'retrograde'
  | 'normal'
  | 'antinormal'
  | 'radialOut'
  | 'radialIn'
  | 'target';

/** Fixed snapshot storage for the dominant-body osculating solution. */
export interface OsculatingElementsSnapshot {
  valid: boolean;
  semiMajorAxisKm: number;
  eccentricity: number;
  inclinationRad: number;
  longitudeAscendingNodeRad: number;
  argumentPeriapsisRad: number;
  trueAnomalyRad: number;
  periapsisRadiusKm: number;
  apoapsisRadiusKm: number;
  periodSec: number;
}

/**
 * Immutable-per-frame physical state consumed by game, render, and UI layers.
 * Storage is reused after one intervening step; long-lived consumers must copy.
 */
export interface SimSnapshot {
  readonly simTimeSec: number;
  readonly utcTimeMs: number;
  readonly shipProperTimeSec: number;
  readonly requestedWarp: WarpFactor;
  readonly effectiveWarp: WarpFactor;
  readonly warpClampReason: WarpClampReason;
  readonly bodyIds: readonly string[];
  readonly bodyPositionsKm: Float64Array;
  readonly bodyVelocitiesKmS: Float64Array;
  readonly shipState: Float64Array;
  readonly shipCoordinateVelocityKmS: Float64Array;
  readonly shipCmRelativeVelocityKmS: Float64Array;
  readonly shipProperAccelerationKmS2: Float64Array;
  readonly shipThrustVectorN: Float64Array;
  readonly shipRelativisticMomentumKgKmS: Float64Array;
  readonly shipAngularMomentumKgKm2S: Float64Array;
  readonly barycenterPositionKm: Float64Array;
  readonly barycenterVelocityKmS: Float64Array;
  readonly attitudeQuaternion: Float64Array;
  readonly attitudeMode: AttitudeMode;
  readonly throttle: number;
  readonly gamma: number;
  readonly speedFractionOfLight: number;
  readonly powerDrawW: number;
  readonly energySpentJ: number;
  readonly properDeltaVMS: number;
  readonly kineticEnergyChangeJ: number;
  readonly burnSummaryAvailable: boolean;
  readonly burnSummaryActive: boolean;
  readonly burnEnergySpentJ: number;
  readonly burnProperDeltaVMS: number;
  readonly dominantBodyIndex: number;
  readonly osculatingElements: OsculatingElementsSnapshot;
  readonly warningFlags: number;
  readonly targetBodyIndex: number;
  readonly targetBodyId: string | null;
  /**
   * ADR-036 — surface contact. `1` freezes integration until the game layer
   * restores or respawns; the remaining three fields are meaningless while `0`.
   */
  readonly impactOccurred: 0 | 1;
  /** Body contacted, or -1 when none. */
  readonly impactBodyIndex: number;
  /** Closing speed against the body centre at contact, km/s. */
  readonly impactSpeedKmS: number;
  /** Coordinate time of contact, bisected to within 1 ms. */
  readonly impactSimTimeSec: number;
}

/** Internal writable form of one preallocated snapshot buffer. */
export interface SimulationSnapshotBuffer extends SimSnapshot {
  simTimeSec: number;
  utcTimeMs: number;
  shipProperTimeSec: number;
  requestedWarp: WarpFactor;
  effectiveWarp: WarpFactor;
  warpClampReason: WarpClampReason;
  attitudeMode: AttitudeMode;
  throttle: number;
  gamma: number;
  speedFractionOfLight: number;
  powerDrawW: number;
  energySpentJ: number;
  properDeltaVMS: number;
  kineticEnergyChangeJ: number;
  burnSummaryAvailable: boolean;
  burnSummaryActive: boolean;
  burnEnergySpentJ: number;
  burnProperDeltaVMS: number;
  dominantBodyIndex: number;
  warningFlags: number;
  targetBodyIndex: number;
  targetBodyId: string | null;
  impactOccurred: 0 | 1;
  impactBodyIndex: number;
  impactSpeedKmS: number;
  impactSimTimeSec: number;
}

/** Mutable command values retained without allocating in the frame loop. */
export interface CommandState {
  throttle: number;
  attitudeMode: AttitudeMode;
  readonly rotationRatesRadS: Float64Array;
  requestedWarp: WarpFactor;
  targetBodyIndex: number;
  targetBodyId: string | null;
  /**
   * ADR-036 — set by `SimulationCore` on surface contact. Commands clamp to a
   * frozen ship's reality (no thrust, no rates, 1x) exactly as they already
   * clamp above `MAX_THRUST_WARP` and `MANUAL_ATTITUDE_MAX_WARP`, so a UI that
   * keeps sending intent cannot open a burn at a frozen timestamp.
   */
  impactFrozen: boolean;
}

/** The only public route for player intent to enter `SimulationCore`. */
export interface Commands {
  setThrottle(fraction: number): void;
  setAttitudeMode(mode: AttitudeMode): void;
  rotate(pitchRateRadS: number, yawRateRadS: number, rollRateRadS: number): void;
  setWarp(warp: WarpFactor): void;
  setTarget(bodyId: string | null): void;
}

/** Setup-time pair connecting the public command facade to core-owned state. */
export interface CommandController {
  readonly commands: Commands;
  readonly state: CommandState;
}

/** Synchronous setup-provided event fired when active thrust intent changes. */
export type TrajectoryInvalidationListener = () => void;

/** Synchronous observer for actual throttle transitions. */
export type ThrottleChangeListener = (previousThrottle: number, nextThrottle: number) => void;

function createOsculatingElementsStorage(): OsculatingElementsSnapshot {
  return {
    valid: false,
    semiMajorAxisKm: Number.NaN,
    eccentricity: Number.NaN,
    inclinationRad: Number.NaN,
    longitudeAscendingNodeRad: Number.NaN,
    argumentPeriapsisRad: Number.NaN,
    trueAnomalyRad: Number.NaN,
    periapsisRadiusKm: Number.NaN,
    apoapsisRadiusKm: Number.NaN,
    periodSec: Number.NaN,
  };
}

/** Allocates one complete snapshot buffer during simulation setup. */
export function createSimulationSnapshotBuffer(
  bodyIds: readonly string[],
): SimulationSnapshotBuffer {
  const bodyComponentCount = bodyIds.length * 3;
  return {
    simTimeSec: 0,
    utcTimeMs: 0,
    shipProperTimeSec: 0,
    requestedWarp: 1,
    effectiveWarp: 1,
    warpClampReason: WarpClampReason.NONE,
    bodyIds,
    bodyPositionsKm: new Float64Array(bodyComponentCount),
    bodyVelocitiesKmS: new Float64Array(bodyComponentCount),
    shipState: new Float64Array(RELATIVISTIC_STATE_DIMENSION),
    shipCoordinateVelocityKmS: new Float64Array(3),
    shipCmRelativeVelocityKmS: new Float64Array(3),
    shipProperAccelerationKmS2: new Float64Array(3),
    shipThrustVectorN: new Float64Array(3),
    shipRelativisticMomentumKgKmS: new Float64Array(3),
    shipAngularMomentumKgKm2S: new Float64Array(3),
    barycenterPositionKm: new Float64Array(3),
    barycenterVelocityKmS: new Float64Array(3),
    attitudeQuaternion: new Float64Array([0, 0, 0, 1]),
    attitudeMode: 'manual',
    throttle: 0,
    gamma: 1,
    speedFractionOfLight: 0,
    powerDrawW: 0,
    energySpentJ: 0,
    properDeltaVMS: 0,
    kineticEnergyChangeJ: 0,
    burnSummaryAvailable: false,
    burnSummaryActive: false,
    burnEnergySpentJ: 0,
    burnProperDeltaVMS: 0,
    dominantBodyIndex: -1,
    osculatingElements: createOsculatingElementsStorage(),
    warningFlags: WarningFlag.NONE,
    targetBodyIndex: -1,
    targetBodyId: null,
    impactOccurred: 0,
    impactBodyIndex: -1,
    impactSpeedKmS: 0,
    impactSimTimeSec: 0,
  };
}

function isAttitudeMode(mode: string): mode is AttitudeMode {
  switch (mode) {
    case 'manual':
    case 'prograde':
    case 'retrograde':
    case 'normal':
    case 'antinormal':
    case 'radialOut':
    case 'radialIn':
    case 'target':
      return true;
    default:
      return false;
  }
}

function isWarpFactor(value: number): value is WarpFactor {
  for (let index = 0; index < WARP_LADDER.length; index += 1) {
    if (WARP_LADDER[index] === value) return true;
  }
  return false;
}

class SimulationCommands implements Commands {
  constructor(
    private readonly bodyIds: readonly string[],
    private readonly commandState: CommandState,
    private readonly onTrajectoryInvalidated: TrajectoryInvalidationListener | null,
    private readonly onThrottleChanged: ThrottleChangeListener | null,
  ) {}

  setThrottle(fraction: number): void {
    if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) {
      throw new RangeError('throttle must be a finite fraction in [0, 1]');
    }
    const effectiveFraction =
      this.commandState.impactFrozen || this.commandState.requestedWarp > MAX_THRUST_WARP
        ? 0
        : fraction;
    if (effectiveFraction === this.commandState.throttle) return;
    const previousThrottle = this.commandState.throttle;
    this.commandState.throttle = effectiveFraction;
    this.onThrottleChanged?.(previousThrottle, effectiveFraction);
    this.onTrajectoryInvalidated?.();
  }

  setAttitudeMode(mode: AttitudeMode): void {
    if (!isAttitudeMode(mode)) throw new RangeError('attitude mode is not supported');
    if (mode === this.commandState.attitudeMode) return;
    this.commandState.attitudeMode = mode;
    if (this.commandState.throttle > 0) this.onTrajectoryInvalidated?.();
  }

  rotate(pitchRateRadS: number, yawRateRadS: number, rollRateRadS: number): void {
    if (
      !Number.isFinite(pitchRateRadS) ||
      !Number.isFinite(yawRateRadS) ||
      !Number.isFinite(rollRateRadS)
    ) {
      throw new RangeError('rotation rates must be finite');
    }
    // ADR-035 — manual rotation is a regime, not a validation error: rates above
    // MANUAL_ATTITUDE_MAX_WARP are forced to zero exactly as setThrottle forces
    // throttle to zero above MAX_THRUST_WARP. Holds remain available there.
    const locked =
      this.commandState.impactFrozen || this.commandState.requestedWarp > MANUAL_ATTITUDE_MAX_WARP;
    const effectivePitchRateRadS = locked ? 0 : pitchRateRadS;
    const effectiveYawRateRadS = locked ? 0 : yawRateRadS;
    const effectiveRollRateRadS = locked ? 0 : rollRateRadS;
    if (
      effectivePitchRateRadS === this.commandState.rotationRatesRadS[0] &&
      effectiveYawRateRadS === this.commandState.rotationRatesRadS[1] &&
      effectiveRollRateRadS === this.commandState.rotationRatesRadS[2]
    ) {
      return;
    }
    this.commandState.rotationRatesRadS[0] = effectivePitchRateRadS;
    this.commandState.rotationRatesRadS[1] = effectiveYawRateRadS;
    this.commandState.rotationRatesRadS[2] = effectiveRollRateRadS;
    if (this.commandState.throttle > 0 && this.commandState.attitudeMode === 'manual') {
      this.onTrajectoryInvalidated?.();
    }
  }

  setWarp(warp: WarpFactor): void {
    if (!isWarpFactor(warp)) throw new RangeError('warp must use the canonical ladder');
    // ADR-036 — a frozen ship is pinned at 1x. The ladder means nothing while no
    // time is passing, and a stored high tier would be re-applied the instant the
    // player recovers, which is not what pressing a warp button before a restore
    // means. Throttle and rates are already zero here, so nothing else to clear.
    if (this.commandState.impactFrozen) {
      this.commandState.requestedWarp = 1;
      return;
    }
    this.commandState.requestedWarp = warp;
    let invalidated = false;
    if (warp > MAX_THRUST_WARP && this.commandState.throttle > 0) {
      const previousThrottle = this.commandState.throttle;
      this.commandState.throttle = 0;
      this.onThrottleChanged?.(previousThrottle, 0);
      invalidated = true;
    }
    // Without this the lockout would be decorative: the v1 tumble came from rates
    // commanded *before* the warp increase surviving it and being multiplied by it.
    if (warp > MANUAL_ATTITUDE_MAX_WARP && this.clearRotationRates()) {
      invalidated ||= this.commandState.throttle > 0 && this.commandState.attitudeMode === 'manual';
    }
    if (invalidated) this.onTrajectoryInvalidated?.();
  }

  /** Zeroes commanded body rates in place; returns whether anything changed. */
  private clearRotationRates(): boolean {
    const rates = this.commandState.rotationRatesRadS;
    if (rates[0] === 0 && rates[1] === 0 && rates[2] === 0) return false;
    rates[0] = 0;
    rates[1] = 0;
    rates[2] = 0;
    return true;
  }

  setTarget(bodyId: string | null): void {
    if (bodyId === null) {
      if (this.commandState.targetBodyId === null) return;
      this.commandState.targetBodyIndex = -1;
      this.commandState.targetBodyId = null;
      if (this.commandState.throttle > 0 && this.commandState.attitudeMode === 'target') {
        this.onTrajectoryInvalidated?.();
      }
      return;
    }
    const bodyIndex = this.bodyIds.indexOf(bodyId);
    if (bodyIndex < 0) throw new RangeError('target body must exist in the simulation catalog');
    if (bodyIndex === this.commandState.targetBodyIndex) return;
    this.commandState.targetBodyIndex = bodyIndex;
    this.commandState.targetBodyId = bodyId;
    if (this.commandState.throttle > 0 && this.commandState.attitudeMode === 'target') {
      this.onTrajectoryInvalidated?.();
    }
  }
}

/** Allocates a stable command facade and its mutable backing state at setup. */
export function createCommandController(
  bodyIds: readonly string[],
  onTrajectoryInvalidated: TrajectoryInvalidationListener | null = null,
  onThrottleChanged: ThrottleChangeListener | null = null,
): CommandController {
  const state: CommandState = {
    throttle: 0,
    attitudeMode: 'manual',
    rotationRatesRadS: new Float64Array(3),
    requestedWarp: 1,
    targetBodyIndex: -1,
    targetBodyId: null,
    impactFrozen: false,
  };
  return {
    commands: new SimulationCommands(bodyIds, state, onTrajectoryInvalidated, onThrottleChanged),
    state,
  };
}
