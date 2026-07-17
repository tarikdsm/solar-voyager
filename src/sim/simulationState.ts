import { MAX_THRUST_WARP, WARP_LADDER, type WarpFactor } from '../core/time.js';
import {
  WarpClampReason,
  type AttitudeMode,
  type WarpClampReason as WarpClampReasonType,
} from './simulationSnapshot.js';
import {
  createBurnLog,
  SIMULATION_STATE_DIMENSION,
  type BurnLogPersistentState,
} from './ship/ledger.js';

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
