import { WARP_LADDER, type WarpFactor } from '../core/time.js';
import {
  copyAndValidateSimulationPersistentState,
  type SimulationPersistentState,
} from '../sim/simulationState.js';
import { WarpClampReason, type AttitudeMode } from '../sim/simulationSnapshot.js';
import {
  DEFAULT_BURN_LOG_CAPACITY,
  SIMULATION_STATE_DIMENSION,
  STATE_ENERGY_J,
  STATE_PROPER_DELTA_V_MS,
  type ActiveBurnPersistentState,
  type BurnLogEntry,
  type BurnLogPersistentState,
} from '../sim/ship/ledger.js';
import { RELATIVISTIC_STATE_DIMENSION } from '../sim/ship/relativity.js';
import { parseGameSettings, type GameSettingsV1, type KeyValueStorage } from './settings.js';

export const CURRENT_SAVE_VERSION = 2;
export const SAVE_STORAGE_KEY = 'solar-voyager.save.v2';

export interface SaveEnvelopeV2 {
  readonly version: 2;
  readonly phase: 'space';
  readonly simulation: SimulationPersistentState;
  readonly settings: GameSettingsV1;
}

export type SaveLoadResult =
  | { readonly ok: true; readonly envelope: SaveEnvelopeV2 }
  | { readonly ok: false; readonly reason: 'not-found' }
  | { readonly ok: false; readonly reason: 'invalid' | 'storage'; readonly error: string };

export type SaveWriteResult =
  { readonly ok: true } | { readonly ok: false; readonly error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new RangeError(`${path} must be an object`);
  return value;
}

function requireExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  path: string,
): void {
  const actual = Object.keys(value);
  for (let index = 0; index < actual.length; index += 1) {
    const key = actual[index];
    if (key !== undefined && !expected.includes(key)) {
      throw new RangeError(`${path} contains unknown field ${key}`);
    }
  }
  for (let index = 0; index < expected.length; index += 1) {
    const key = expected[index];
    if (key !== undefined && !(key in value)) throw new RangeError(`${path}.${key} is missing`);
  }
}

function requireFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new RangeError(`${path} must be a finite number`);
  }
  return value;
}

function requireInteger(value: unknown, path: string): number {
  const numberValue = requireFiniteNumber(value, path);
  if (!Number.isInteger(numberValue)) throw new RangeError(`${path} must be an integer`);
  return numberValue;
}

function requireNullableString(value: unknown, path: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length === 0) {
    throw new RangeError(`${path} must be a nonempty string or null`);
  }
  return value;
}

function requireFloat64Array(value: unknown, length: number, path: string): Float64Array {
  if (!Array.isArray(value) || value.length !== length) {
    throw new RangeError(`${path} must contain ${length} numbers`);
  }
  const result = new Float64Array(length);
  for (let index = 0; index < length; index += 1) {
    result[index] = requireFiniteNumber(value[index], `${path}[${index}]`);
  }
  return result;
}

function requireAttitudeMode(value: unknown, path: string): AttitudeMode {
  switch (value) {
    case 'manual':
    case 'prograde':
    case 'retrograde':
    case 'normal':
    case 'antinormal':
    case 'radialOut':
    case 'radialIn':
    case 'target':
      return value;
    default:
      throw new RangeError(`${path} is not a supported attitude mode`);
  }
}

function requireWarpFactor(value: unknown, path: string): WarpFactor {
  const warp = requireFiniteNumber(value, path);
  for (let index = 0; index < WARP_LADDER.length; index += 1) {
    if (WARP_LADDER[index] === warp) return WARP_LADDER[index] as WarpFactor;
  }
  throw new RangeError(`${path} must use the canonical warp ladder`);
}

function requireWarpClampReason(value: unknown, path: string) {
  if (
    value === WarpClampReason.NONE ||
    value === WarpClampReason.INTEGRATION_BUDGET ||
    value === WarpClampReason.THRUST_LOCKOUT
  ) {
    return value;
  }
  throw new RangeError(`${path} is not a supported warp clamp reason`);
}

const BURN_ENTRY_KEYS = Object.freeze([
  'startTimeSec',
  'endTimeSec',
  'startProperTimeSec',
  'endProperTimeSec',
  'energySpentJ',
  'properDeltaVMS',
  'peakPowerW',
  'dominantBodyId',
  'progradeDeltaVMS',
  'normalDeltaVMS',
  'radialDeltaVMS',
]);

function parseBurnEntry(value: unknown, path: string): BurnLogEntry {
  const record = requireRecord(value, path);
  requireExactKeys(record, BURN_ENTRY_KEYS, path);
  return {
    startTimeSec: requireFiniteNumber(record.startTimeSec, `${path}.startTimeSec`),
    endTimeSec: requireFiniteNumber(record.endTimeSec, `${path}.endTimeSec`),
    startProperTimeSec: requireFiniteNumber(
      record.startProperTimeSec,
      `${path}.startProperTimeSec`,
    ),
    endProperTimeSec: requireFiniteNumber(record.endProperTimeSec, `${path}.endProperTimeSec`),
    energySpentJ: requireFiniteNumber(record.energySpentJ, `${path}.energySpentJ`),
    properDeltaVMS: requireFiniteNumber(record.properDeltaVMS, `${path}.properDeltaVMS`),
    peakPowerW: requireFiniteNumber(record.peakPowerW, `${path}.peakPowerW`),
    dominantBodyId: requireNullableString(record.dominantBodyId, `${path}.dominantBodyId`),
    progradeDeltaVMS: requireFiniteNumber(record.progradeDeltaVMS, `${path}.progradeDeltaVMS`),
    normalDeltaVMS: requireFiniteNumber(record.normalDeltaVMS, `${path}.normalDeltaVMS`),
    radialDeltaVMS: requireFiniteNumber(record.radialDeltaVMS, `${path}.radialDeltaVMS`),
  };
}

function parseActiveBurn(value: unknown, path: string): ActiveBurnPersistentState | null {
  if (value === null) return null;
  const record = requireRecord(value, path);
  requireExactKeys(
    record,
    [
      'entry',
      'startEnergyJ',
      'startProperDeltaVMS',
      'startVectorMS',
      'progradeBasis',
      'normalBasis',
      'radialBasis',
    ],
    path,
  );
  return {
    entry: parseBurnEntry(record.entry, `${path}.entry`),
    startEnergyJ: requireFiniteNumber(record.startEnergyJ, `${path}.startEnergyJ`),
    startProperDeltaVMS: requireFiniteNumber(
      record.startProperDeltaVMS,
      `${path}.startProperDeltaVMS`,
    ),
    startVectorMS: requireFloat64Array(record.startVectorMS, 3, `${path}.startVectorMS`),
    progradeBasis: requireFloat64Array(record.progradeBasis, 3, `${path}.progradeBasis`),
    normalBasis: requireFloat64Array(record.normalBasis, 3, `${path}.normalBasis`),
    radialBasis: requireFloat64Array(record.radialBasis, 3, `${path}.radialBasis`),
  };
}

function parseBurnLog(value: unknown, path: string): BurnLogPersistentState {
  const record = requireRecord(value, path);
  requireExactKeys(record, ['capacity', 'entries', 'active'], path);
  const capacity = requireInteger(record.capacity, `${path}.capacity`);
  if (capacity <= 0) throw new RangeError(`${path}.capacity must be positive`);
  if (!Array.isArray(record.entries)) throw new RangeError(`${path}.entries must be an array`);
  const entries: BurnLogEntry[] = [];
  for (let index = 0; index < record.entries.length; index += 1) {
    entries.push(parseBurnEntry(record.entries[index], `${path}.entries[${index}]`));
  }
  return {
    capacity,
    entries,
    active: parseActiveBurn(record.active, `${path}.active`),
  };
}

function parseSimulationState(
  value: unknown,
  bodyIds: readonly string[],
): SimulationPersistentState {
  const path = 'save.simulation';
  const record = requireRecord(value, path);
  requireExactKeys(
    record,
    [
      'simTimeSec',
      'state',
      'attitudeQuaternion',
      'throttle',
      'attitudeMode',
      'rotationRatesRadS',
      'requestedWarp',
      'effectiveWarp',
      'warpClampReason',
      'targetBodyId',
      'initialKineticEnergyJ',
      'burnLog',
    ],
    path,
  );
  return copyAndValidateSimulationPersistentState(
    {
      simTimeSec: requireFiniteNumber(record.simTimeSec, `${path}.simTimeSec`),
      state: requireFloat64Array(record.state, SIMULATION_STATE_DIMENSION, `${path}.state`),
      attitudeQuaternion: requireFloat64Array(
        record.attitudeQuaternion,
        4,
        `${path}.attitudeQuaternion`,
      ),
      throttle: requireFiniteNumber(record.throttle, `${path}.throttle`),
      attitudeMode: requireAttitudeMode(record.attitudeMode, `${path}.attitudeMode`),
      rotationRatesRadS: requireFloat64Array(
        record.rotationRatesRadS,
        3,
        `${path}.rotationRatesRadS`,
      ),
      requestedWarp: requireWarpFactor(record.requestedWarp, `${path}.requestedWarp`),
      effectiveWarp: requireWarpFactor(record.effectiveWarp, `${path}.effectiveWarp`),
      warpClampReason: requireWarpClampReason(record.warpClampReason, `${path}.warpClampReason`),
      targetBodyId: requireNullableString(record.targetBodyId, `${path}.targetBodyId`),
      initialKineticEnergyJ: requireFiniteNumber(
        record.initialKineticEnergyJ,
        `${path}.initialKineticEnergyJ`,
      ),
      burnLog: parseBurnLog(record.burnLog, `${path}.burnLog`),
    },
    bodyIds,
  );
}

function parseV2(value: Record<string, unknown>, bodyIds: readonly string[]): SaveEnvelopeV2 {
  requireExactKeys(value, ['version', 'phase', 'simulation', 'settings'], 'save');
  if (value.version !== 2) throw new RangeError('save version must be 2');
  if (value.phase !== 'space') throw new RangeError('save phase must be space');
  return {
    version: 2,
    phase: 'space',
    simulation: parseSimulationState(value.simulation, bodyIds),
    settings: parseGameSettings(value.settings),
  };
}

function migrateV1(value: Record<string, unknown>, bodyIds: readonly string[]): SaveEnvelopeV2 {
  requireExactKeys(
    value,
    ['version', 'simTimeSec', 'phase', 'shipState', 'ledger', 'burnLog', 'settings'],
    'save v1',
  );
  if (value.phase !== 'space') throw new RangeError('save v1 phase must be space');
  const shipState = requireFloat64Array(
    value.shipState,
    RELATIVISTIC_STATE_DIMENSION,
    'save v1.shipState',
  );
  const ledger = requireRecord(value.ledger, 'save v1.ledger');
  requireExactKeys(ledger, ['energySpentJ', 'properDeltaVMS'], 'save v1.ledger');
  const state = new Float64Array(SIMULATION_STATE_DIMENSION);
  state.set(shipState);
  state[STATE_ENERGY_J] = requireFiniteNumber(ledger.energySpentJ, 'save v1.ledger.energySpentJ');
  state[STATE_PROPER_DELTA_V_MS] = requireFiniteNumber(
    ledger.properDeltaVMS,
    'save v1.ledger.properDeltaVMS',
  );
  if (!Array.isArray(value.burnLog)) throw new RangeError('save v1.burnLog must be an array');
  const entries: BurnLogEntry[] = [];
  for (let index = 0; index < value.burnLog.length; index += 1) {
    entries.push(parseBurnEntry(value.burnLog[index], `save v1.burnLog[${index}]`));
  }
  return createSaveEnvelope(
    {
      simTimeSec: requireFiniteNumber(value.simTimeSec, 'save v1.simTimeSec'),
      state,
      attitudeQuaternion: new Float64Array([0, 0, 0, 1]),
      throttle: 0,
      attitudeMode: 'manual',
      rotationRatesRadS: new Float64Array(3),
      requestedWarp: 1,
      effectiveWarp: 1,
      warpClampReason: WarpClampReason.NONE,
      targetBodyId: null,
      initialKineticEnergyJ: 0,
      burnLog: { capacity: DEFAULT_BURN_LOG_CAPACITY, entries, active: null },
    },
    parseGameSettings(value.settings),
    bodyIds,
  );
}

/** Creates a validated ownership-safe v2 envelope. */
export function createSaveEnvelope(
  simulation: SimulationPersistentState,
  settings: GameSettingsV1,
  bodyIds: readonly string[],
): SaveEnvelopeV2 {
  return {
    version: 2,
    phase: 'space',
    simulation: copyAndValidateSimulationPersistentState(simulation, bodyIds),
    settings: parseGameSettings(settings),
  };
}

function burnEntryToJson(entry: BurnLogEntry): BurnLogEntry {
  return { ...entry };
}

function burnLogToJson(burnLog: BurnLogPersistentState) {
  return {
    capacity: burnLog.capacity,
    entries: burnLog.entries.map(burnEntryToJson),
    active:
      burnLog.active === null
        ? null
        : {
            entry: burnEntryToJson(burnLog.active.entry),
            startEnergyJ: burnLog.active.startEnergyJ,
            startProperDeltaVMS: burnLog.active.startProperDeltaVMS,
            startVectorMS: Array.from(burnLog.active.startVectorMS),
            progradeBasis: Array.from(burnLog.active.progradeBasis),
            normalBasis: Array.from(burnLog.active.normalBasis),
            radialBasis: Array.from(burnLog.active.radialBasis),
          },
  };
}

/** Serializes typed simulation storage into a portable JSON document. */
export function serializeSaveEnvelope(envelope: SaveEnvelopeV2): string {
  const simulation = envelope.simulation;
  return JSON.stringify({
    version: 2,
    phase: 'space',
    simulation: {
      simTimeSec: simulation.simTimeSec,
      state: Array.from(simulation.state),
      attitudeQuaternion: Array.from(simulation.attitudeQuaternion),
      throttle: simulation.throttle,
      attitudeMode: simulation.attitudeMode,
      rotationRatesRadS: Array.from(simulation.rotationRatesRadS),
      requestedWarp: simulation.requestedWarp,
      effectiveWarp: simulation.effectiveWarp,
      warpClampReason: simulation.warpClampReason,
      targetBodyId: simulation.targetBodyId,
      initialKineticEnergyJ: simulation.initialKineticEnergyJ,
      burnLog: burnLogToJson(simulation.burnLog),
    },
    settings: envelope.settings,
  });
}

/** Parses, migrates, and validates an imported or stored save document. */
export function parseSaveEnvelope(text: string, bodyIds: readonly string[]): SaveEnvelopeV2 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new RangeError(`Unable to parse save JSON: ${message}`);
  }
  const record = requireRecord(parsed, 'save');
  if (record.version === 1) return migrateV1(record, bodyIds);
  if (record.version === 2) return parseV2(record, bodyIds);
  throw new RangeError('save version is not supported');
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Owns the canonical browser save slot through a localStorage-compatible port. */
export class SaveRepository {
  constructor(private readonly storage: KeyValueStorage) {}

  load(bodyIds: readonly string[]): SaveLoadResult {
    let text: string | null;
    try {
      text = this.storage.getItem(SAVE_STORAGE_KEY);
    } catch (error: unknown) {
      return {
        ok: false,
        reason: 'storage',
        error: `Unable to read save: ${describeError(error)}`,
      };
    }
    if (text === null) return { ok: false, reason: 'not-found' };
    try {
      return { ok: true, envelope: parseSaveEnvelope(text, bodyIds) };
    } catch (error: unknown) {
      return { ok: false, reason: 'invalid', error: describeError(error) };
    }
  }

  save(envelope: SaveEnvelopeV2): SaveWriteResult {
    try {
      this.storage.setItem(SAVE_STORAGE_KEY, serializeSaveEnvelope(envelope));
      return { ok: true };
    } catch (error: unknown) {
      return { ok: false, error: `Unable to write save: ${describeError(error)}` };
    }
  }
}
