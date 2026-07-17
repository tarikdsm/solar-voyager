import { MAX_THRUST_WARP, WARP_LADDER, type WarpFactor } from '../core/time.js';
import {
  WarpClampReason,
  type AttitudeMode,
  type WarpClampReason as WarpClampReasonType,
} from './simulationSnapshot.js';
import {
  createBurnLog,
  DEFAULT_BURN_LOG_CAPACITY,
  SIMULATION_STATE_DIMENSION,
  STATE_ENERGY_J,
  STATE_PROPER_DELTA_V_MS,
  STATE_PROPER_DELTA_V_VECTOR_X_MS,
  STATE_PROPER_DELTA_V_VECTOR_Y_MS,
  STATE_PROPER_DELTA_V_VECTOR_Z_MS,
  type ActiveBurnPersistentState,
  type BurnLogPersistentState,
} from './ship/ledger.js';
import { STATE_TAU } from './ship/relativity.js';

/** Setup-time state needed to reconstruct a SimulationCore exactly. */
export interface SimulationPersistentState {
  readonly simTimeSec: number;
  readonly state: Float64Array;
  readonly attitudeQuaternion: Float64Array;
  readonly throttle: number;
  readonly attitudeMode: AttitudeMode;
  readonly rotationRatesRadS: Float64Array;
  readonly requestedWarp: WarpFactor;
  readonly effectiveWarp: WarpFactor;
  readonly warpClampReason: WarpClampReasonType;
  readonly targetBodyId: string | null;
  readonly initialKineticEnergyJ: number;
  readonly burnLog: BurnLogPersistentState;
}

function copyFiniteArray(source: Float64Array, length: number, label: string): Float64Array {
  if (!(source instanceof Float64Array) || source.length !== length) {
    throw new RangeError(`${label} must contain ${length} float64 components`);
  }
  const copy = new Float64Array(source);
  for (let index = 0; index < copy.length; index += 1) {
    if (!Number.isFinite(copy[index])) throw new RangeError(`${label} must be finite`);
  }
  return copy;
}

function isAttitudeMode(value: string): value is AttitudeMode {
  switch (value) {
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

function isWarpClampReason(value: number): value is WarpClampReasonType {
  return (
    value === WarpClampReason.NONE ||
    value === WarpClampReason.INTEGRATION_BUDGET ||
    value === WarpClampReason.THRUST_LOCKOUT
  );
}

function nearlyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= 1e-10 * Math.max(1, Math.abs(left), Math.abs(right));
}

function dot(left: Float64Array, right: Float64Array): number {
  return (
    (left[0] as number) * (right[0] as number) +
    (left[1] as number) * (right[1] as number) +
    (left[2] as number) * (right[2] as number)
  );
}

function validateActiveBurnConsistency(
  simTimeSec: number,
  state: Float64Array,
  active: ActiveBurnPersistentState,
): void {
  const entry = active.entry;
  if (
    !nearlyEqual(entry.endTimeSec, simTimeSec) ||
    !nearlyEqual(entry.endProperTimeSec, state[STATE_TAU] as number)
  ) {
    throw new RangeError('persistent active burn endpoint must match simulation time');
  }
  const energySpentJ = (state[STATE_ENERGY_J] as number) - active.startEnergyJ;
  const properDeltaVMS = (state[STATE_PROPER_DELTA_V_MS] as number) - active.startProperDeltaVMS;
  if (
    entry.energySpentJ < 0 ||
    entry.properDeltaVMS < 0 ||
    !nearlyEqual(entry.energySpentJ, energySpentJ) ||
    !nearlyEqual(entry.properDeltaVMS, properDeltaVMS)
  ) {
    throw new RangeError('persistent active burn ledger must match simulation totals');
  }
  const bases = [active.progradeBasis, active.normalBasis, active.radialBasis];
  for (let index = 0; index < bases.length; index += 1) {
    const basis = bases[index];
    if (basis === undefined || !nearlyEqual(dot(basis, basis), 1)) {
      throw new RangeError('persistent active burn must use a normalized orbital frame');
    }
  }
  if (
    !nearlyEqual(dot(active.progradeBasis, active.normalBasis), 0) ||
    !nearlyEqual(dot(active.normalBasis, active.radialBasis), 0)
  ) {
    throw new RangeError('persistent active burn must use a normalized orbital frame');
  }
  const currentVector = new Float64Array([
    state[STATE_PROPER_DELTA_V_VECTOR_X_MS] as number,
    state[STATE_PROPER_DELTA_V_VECTOR_Y_MS] as number,
    state[STATE_PROPER_DELTA_V_VECTOR_Z_MS] as number,
  ]);
  const deltaVector = new Float64Array([
    (currentVector[0] as number) - (active.startVectorMS[0] as number),
    (currentVector[1] as number) - (active.startVectorMS[1] as number),
    (currentVector[2] as number) - (active.startVectorMS[2] as number),
  ]);
  if (
    !nearlyEqual(entry.progradeDeltaVMS, dot(deltaVector, active.progradeBasis)) ||
    !nearlyEqual(entry.normalDeltaVMS, dot(deltaVector, active.normalBasis)) ||
    !nearlyEqual(entry.radialDeltaVMS, dot(deltaVector, active.radialBasis))
  ) {
    throw new RangeError('persistent active burn components must match simulation totals');
  }
}

/** Validates untrusted setup data and returns an ownership-safe deep copy. */
export function copyAndValidateSimulationPersistentState(
  source: SimulationPersistentState,
  bodyIds: readonly string[],
): SimulationPersistentState {
  if (!Number.isFinite(source.simTimeSec)) {
    throw new RangeError('persistent simulation time must be finite');
  }
  const state = copyFiniteArray(source.state, SIMULATION_STATE_DIMENSION, 'persistent state');
  const attitudeQuaternion = copyFiniteArray(
    source.attitudeQuaternion,
    4,
    'persistent attitude quaternion',
  );
  if (Math.abs(Math.hypot(...attitudeQuaternion) - 1) > 1e-12) {
    throw new RangeError('persistent attitude must be a unit quaternion');
  }
  if (!Number.isFinite(source.throttle) || source.throttle < 0 || source.throttle > 1) {
    throw new RangeError('persistent throttle must be a finite fraction in [0, 1]');
  }
  if (!isAttitudeMode(source.attitudeMode)) {
    throw new RangeError('persistent attitude mode is not supported');
  }
  const rotationRatesRadS = copyFiniteArray(
    source.rotationRatesRadS,
    3,
    'persistent rotation rates',
  );
  if (!isWarpFactor(source.requestedWarp) || !isWarpFactor(source.effectiveWarp)) {
    throw new RangeError('persistent warp must use the canonical ladder');
  }
  if (!isWarpClampReason(source.warpClampReason)) {
    throw new RangeError('persistent warp clamp reason is not supported');
  }
  if (source.requestedWarp > MAX_THRUST_WARP && source.throttle > 0) {
    throw new RangeError('persistent throttle must be zero above the thrust warp limit');
  }
  if (source.targetBodyId !== null && !bodyIds.includes(source.targetBodyId)) {
    throw new RangeError('persistent target body must exist in the simulation catalog');
  }
  if (!Number.isFinite(source.initialKineticEnergyJ)) {
    throw new RangeError('persistent kinetic-energy baseline must be finite');
  }
  if (source.burnLog.capacity !== DEFAULT_BURN_LOG_CAPACITY) {
    throw new RangeError(`persistent burn log capacity must be ${DEFAULT_BURN_LOG_CAPACITY}`);
  }
  if (source.burnLog.entries.length > DEFAULT_BURN_LOG_CAPACITY) {
    throw new RangeError('persistent burn log entries exceed capacity');
  }
  const burnLog = createBurnLog(source.burnLog.capacity, source.burnLog).persistence.exportState();
  for (let index = 0; index < burnLog.entries.length; index += 1) {
    const bodyId = burnLog.entries[index]?.dominantBodyId;
    if (bodyId !== null && bodyId !== undefined && !bodyIds.includes(bodyId)) {
      throw new RangeError('persistent burn log body must exist in the simulation catalog');
    }
  }
  const activeBodyId = burnLog.active?.entry.dominantBodyId;
  if (activeBodyId !== null && activeBodyId !== undefined && !bodyIds.includes(activeBodyId)) {
    throw new RangeError('persistent active burn log body must exist in the simulation catalog');
  }
  const activeBurn = burnLog.active;
  if (source.throttle > 0 !== (activeBurn !== null)) {
    throw new RangeError('persistent throttle and active burn must agree');
  }
  if (activeBurn !== null) {
    validateActiveBurnConsistency(source.simTimeSec, state, activeBurn);
  }
  return {
    simTimeSec: source.simTimeSec,
    state,
    attitudeQuaternion,
    throttle: source.throttle,
    attitudeMode: source.attitudeMode,
    rotationRatesRadS,
    requestedWarp: source.requestedWarp,
    effectiveWarp: source.effectiveWarp,
    warpClampReason: source.warpClampReason,
    targetBodyId: source.targetBodyId,
    initialKineticEnergyJ: source.initialKineticEnergyJ,
    burnLog,
  };
}
