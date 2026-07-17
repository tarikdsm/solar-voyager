import { SPEED_OF_LIGHT_KM_S } from '../../core/constants.js';
import { RELATIVISTIC_STATE_DIMENSION } from './relativity.js';

export const STATE_ENERGY_J = RELATIVISTIC_STATE_DIMENSION;
export const STATE_PROPER_DELTA_V_MS = STATE_ENERGY_J + 1;
export const STATE_PROPER_DELTA_V_VECTOR_X_MS = STATE_PROPER_DELTA_V_MS + 1;
export const STATE_PROPER_DELTA_V_VECTOR_Y_MS = STATE_PROPER_DELTA_V_VECTOR_X_MS + 1;
export const STATE_PROPER_DELTA_V_VECTOR_Z_MS = STATE_PROPER_DELTA_V_VECTOR_Y_MS + 1;
export const SIMULATION_STATE_DIMENSION = STATE_PROPER_DELTA_V_VECTOR_Z_MS + 1;
export const DEFAULT_BURN_LOG_CAPACITY = 256;

/** One completed or currently active contiguous thrust interval. */
export interface BurnLogEntry {
  readonly startTimeSec: number;
  readonly endTimeSec: number;
  readonly startProperTimeSec: number;
  readonly endProperTimeSec: number;
  readonly energySpentJ: number;
  readonly properDeltaVMS: number;
  readonly peakPowerW: number;
  readonly dominantBodyId: string | null;
  readonly progradeDeltaVMS: number;
  readonly normalDeltaVMS: number;
  readonly radialDeltaVMS: number;
}

/** Public read-only burn history exposed by SimulationCore. */
export interface BurnLogView {
  readonly capacity: number;
  readonly count: number;
  readonly activeBurn: BurnLogEntry | null;
  get(index: number): BurnLogEntry | null;
}

/** Internal mutation surface retained only by SimulationCore. */
export interface BurnLogRecorder {
  begin(
    timeSec: number,
    properTimeSec: number,
    energySpentJ: number,
    properDeltaVMS: number,
    vectorXMS: number,
    vectorYMS: number,
    vectorZMS: number,
    dominantBodyId: string | null,
    progradeBasis: Float64Array,
    normalBasis: Float64Array,
    radialBasis: Float64Array,
    powerW: number,
  ): void;
  notePeakPower(powerW: number): void;
  synchronize(
    timeSec: number,
    properTimeSec: number,
    energySpentJ: number,
    properDeltaVMS: number,
    vectorXMS: number,
    vectorYMS: number,
    vectorZMS: number,
  ): void;
  end(): void;
}

/** Private continuation data required to resume an active burn exactly. */
export interface ActiveBurnPersistentState {
  readonly entry: BurnLogEntry;
  readonly startEnergyJ: number;
  readonly startProperDeltaVMS: number;
  readonly startVectorMS: Float64Array;
  readonly progradeBasis: Float64Array;
  readonly normalBasis: Float64Array;
  readonly radialBasis: Float64Array;
}

/** Setup-time copy of the fixed-capacity burn log. */
export interface BurnLogPersistentState {
  readonly capacity: number;
  readonly entries: readonly BurnLogEntry[];
  readonly active: ActiveBurnPersistentState | null;
}

/** Capability retained by SimulationCore for explicit save operations. */
export interface BurnLogPersistence {
  exportState(): BurnLogPersistentState;
}

export interface BurnLogController {
  readonly view: BurnLogView;
  readonly recorder: BurnLogRecorder;
  readonly persistence: BurnLogPersistence;
}

interface MutableBurnLogEntry extends BurnLogEntry {
  startTimeSec: number;
  endTimeSec: number;
  startProperTimeSec: number;
  endProperTimeSec: number;
  energySpentJ: number;
  properDeltaVMS: number;
  peakPowerW: number;
  dominantBodyId: string | null;
  progradeDeltaVMS: number;
  normalDeltaVMS: number;
  radialDeltaVMS: number;
}

function createBurnEntry(): MutableBurnLogEntry {
  return {
    startTimeSec: 0,
    endTimeSec: 0,
    startProperTimeSec: 0,
    endProperTimeSec: 0,
    energySpentJ: 0,
    properDeltaVMS: 0,
    peakPowerW: 0,
    dominantBodyId: null,
    progradeDeltaVMS: 0,
    normalDeltaVMS: 0,
    radialDeltaVMS: 0,
  };
}

function copyBurnEntry(target: MutableBurnLogEntry, source: BurnLogEntry): void {
  target.startTimeSec = source.startTimeSec;
  target.endTimeSec = source.endTimeSec;
  target.startProperTimeSec = source.startProperTimeSec;
  target.endProperTimeSec = source.endProperTimeSec;
  target.energySpentJ = source.energySpentJ;
  target.properDeltaVMS = source.properDeltaVMS;
  target.peakPowerW = source.peakPowerW;
  target.dominantBodyId = source.dominantBodyId;
  target.progradeDeltaVMS = source.progradeDeltaVMS;
  target.normalDeltaVMS = source.normalDeltaVMS;
  target.radialDeltaVMS = source.radialDeltaVMS;
}

function cloneBurnEntry(source: BurnLogEntry): BurnLogEntry {
  return { ...source };
}

function validateFiniteBurnEntry(entry: BurnLogEntry, label: string): void {
  const values = [
    entry.startTimeSec,
    entry.endTimeSec,
    entry.startProperTimeSec,
    entry.endProperTimeSec,
    entry.energySpentJ,
    entry.properDeltaVMS,
    entry.peakPowerW,
    entry.progradeDeltaVMS,
    entry.normalDeltaVMS,
    entry.radialDeltaVMS,
  ];
  for (let index = 0; index < values.length; index += 1) {
    if (!Number.isFinite(values[index]))
      throw new RangeError(`${label} must contain finite values`);
  }
  if (entry.endTimeSec < entry.startTimeSec) {
    throw new RangeError(`${label} end time must not precede its start time`);
  }
  if (entry.endProperTimeSec < entry.startProperTimeSec) {
    throw new RangeError(`${label} proper end time must not precede its start time`);
  }
  if (entry.dominantBodyId !== null && entry.dominantBodyId.length === 0) {
    throw new RangeError(`${label} dominant body id must not be empty`);
  }
}

function validateVector(vector: Float64Array, label: string): void {
  if (vector.length !== 3) throw new RangeError(`${label} must contain three components`);
  for (let index = 0; index < vector.length; index += 1) {
    if (!Number.isFinite(vector[index])) throw new RangeError(`${label} must be finite`);
  }
}

/** Writes the five ledger rates evaluated at one integrator stage. */
export function writeLedgerDerivativeRates(
  outputDerivative: Float64Array,
  properAccelerationKmS2: Float64Array,
  inverseGamma: number,
  shipMassKg: number,
): void {
  const alphaXMS2 = (properAccelerationKmS2[0] as number) * 1_000;
  const alphaYMS2 = (properAccelerationKmS2[1] as number) * 1_000;
  const alphaZMS2 = (properAccelerationKmS2[2] as number) * 1_000;
  const alphaMagnitudeMS2 = Math.hypot(alphaXMS2, alphaYMS2, alphaZMS2);
  outputDerivative[STATE_ENERGY_J] = shipMassKg * alphaMagnitudeMS2 * SPEED_OF_LIGHT_KM_S * 1_000;
  outputDerivative[STATE_PROPER_DELTA_V_MS] = alphaMagnitudeMS2 * inverseGamma;
  outputDerivative[STATE_PROPER_DELTA_V_VECTOR_X_MS] = alphaXMS2 * inverseGamma;
  outputDerivative[STATE_PROPER_DELTA_V_VECTOR_Y_MS] = alphaYMS2 * inverseGamma;
  outputDerivative[STATE_PROPER_DELTA_V_VECTOR_Z_MS] = alphaZMS2 * inverseGamma;
}

/** Fixed-capacity, setup-allocated chronological view of contiguous burns. */
class BurnLogStorage implements BurnLogView, BurnLogRecorder, BurnLogPersistence {
  private readonly entries: MutableBurnLogEntry[];
  private readonly activeEntry = createBurnEntry();
  private readonly startVectorMS = new Float64Array(3);
  private readonly progradeBasis = new Float64Array(3);
  private readonly normalBasis = new Float64Array(3);
  private readonly radialBasis = new Float64Array(3);
  private startEnergyJ = 0;
  private startProperDeltaVMS = 0;
  private nextWriteIndex = 0;
  private retainedCount = 0;
  private isActive = false;

  constructor(
    readonly capacity = DEFAULT_BURN_LOG_CAPACITY,
    persistentState: BurnLogPersistentState | null = null,
  ) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError('burn log capacity must be a positive integer');
    }
    this.entries = Array.from({ length: capacity }, createBurnEntry);
    if (persistentState !== null) this.restore(persistentState);
  }

  get count(): number {
    return this.retainedCount;
  }

  get activeBurn(): BurnLogEntry | null {
    return this.isActive ? this.activeEntry : null;
  }

  get(index: number): BurnLogEntry | null {
    if (!Number.isInteger(index) || index < 0 || index >= this.retainedCount) return null;
    const oldestIndex = (this.nextWriteIndex - this.retainedCount + this.capacity) % this.capacity;
    return this.entries[(oldestIndex + index) % this.capacity] ?? null;
  }

  begin(
    timeSec: number,
    properTimeSec: number,
    energySpentJ: number,
    properDeltaVMS: number,
    vectorXMS: number,
    vectorYMS: number,
    vectorZMS: number,
    dominantBodyId: string | null,
    progradeBasis: Float64Array,
    normalBasis: Float64Array,
    radialBasis: Float64Array,
    powerW: number,
  ): void {
    if (this.isActive) {
      this.notePeakPower(powerW);
      return;
    }
    this.isActive = true;
    this.startEnergyJ = energySpentJ;
    this.startProperDeltaVMS = properDeltaVMS;
    this.startVectorMS[0] = vectorXMS;
    this.startVectorMS[1] = vectorYMS;
    this.startVectorMS[2] = vectorZMS;
    this.progradeBasis.set(progradeBasis);
    this.normalBasis.set(normalBasis);
    this.radialBasis.set(radialBasis);
    this.activeEntry.startTimeSec = timeSec;
    this.activeEntry.endTimeSec = timeSec;
    this.activeEntry.startProperTimeSec = properTimeSec;
    this.activeEntry.endProperTimeSec = properTimeSec;
    this.activeEntry.energySpentJ = 0;
    this.activeEntry.properDeltaVMS = 0;
    this.activeEntry.peakPowerW = powerW;
    this.activeEntry.dominantBodyId = dominantBodyId;
    this.activeEntry.progradeDeltaVMS = 0;
    this.activeEntry.normalDeltaVMS = 0;
    this.activeEntry.radialDeltaVMS = 0;
  }

  notePeakPower(powerW: number): void {
    if (this.isActive && powerW > this.activeEntry.peakPowerW) {
      this.activeEntry.peakPowerW = powerW;
    }
  }

  synchronize(
    timeSec: number,
    properTimeSec: number,
    energySpentJ: number,
    properDeltaVMS: number,
    vectorXMS: number,
    vectorYMS: number,
    vectorZMS: number,
  ): void {
    if (!this.isActive) return;
    const deltaXMS = vectorXMS - (this.startVectorMS[0] as number);
    const deltaYMS = vectorYMS - (this.startVectorMS[1] as number);
    const deltaZMS = vectorZMS - (this.startVectorMS[2] as number);
    this.activeEntry.endTimeSec = timeSec;
    this.activeEntry.endProperTimeSec = properTimeSec;
    this.activeEntry.energySpentJ = energySpentJ - this.startEnergyJ;
    this.activeEntry.properDeltaVMS = properDeltaVMS - this.startProperDeltaVMS;
    this.activeEntry.progradeDeltaVMS =
      deltaXMS * (this.progradeBasis[0] as number) +
      deltaYMS * (this.progradeBasis[1] as number) +
      deltaZMS * (this.progradeBasis[2] as number);
    this.activeEntry.normalDeltaVMS =
      deltaXMS * (this.normalBasis[0] as number) +
      deltaYMS * (this.normalBasis[1] as number) +
      deltaZMS * (this.normalBasis[2] as number);
    this.activeEntry.radialDeltaVMS =
      deltaXMS * (this.radialBasis[0] as number) +
      deltaYMS * (this.radialBasis[1] as number) +
      deltaZMS * (this.radialBasis[2] as number);
  }

  end(): void {
    if (!this.isActive) return;
    if (this.activeEntry.energySpentJ > 0 || this.activeEntry.properDeltaVMS > 0) {
      const target = this.entries[this.nextWriteIndex];
      if (target !== undefined) copyBurnEntry(target, this.activeEntry);
      this.nextWriteIndex = (this.nextWriteIndex + 1) % this.capacity;
      this.retainedCount = Math.min(this.retainedCount + 1, this.capacity);
    }
    this.isActive = false;
  }

  exportState(): BurnLogPersistentState {
    const entries: BurnLogEntry[] = [];
    for (let index = 0; index < this.retainedCount; index += 1) {
      const entry = this.get(index);
      if (entry !== null) entries.push(cloneBurnEntry(entry));
    }
    return {
      capacity: this.capacity,
      entries,
      active: this.isActive
        ? {
            entry: cloneBurnEntry(this.activeEntry),
            startEnergyJ: this.startEnergyJ,
            startProperDeltaVMS: this.startProperDeltaVMS,
            startVectorMS: new Float64Array(this.startVectorMS),
            progradeBasis: new Float64Array(this.progradeBasis),
            normalBasis: new Float64Array(this.normalBasis),
            radialBasis: new Float64Array(this.radialBasis),
          }
        : null,
    };
  }

  private restore(state: BurnLogPersistentState): void {
    if (state.capacity !== this.capacity) {
      throw new RangeError('burn log capacity does not match persistent state');
    }
    if (state.entries.length > this.capacity) {
      throw new RangeError('burn log persistent entries exceed capacity');
    }
    for (let index = 0; index < state.entries.length; index += 1) {
      const source = state.entries[index];
      const target = this.entries[index];
      if (source === undefined || target === undefined) {
        throw new RangeError('burn log persistent entries are sparse');
      }
      validateFiniteBurnEntry(source, `burn log entry ${index}`);
      copyBurnEntry(target, source);
    }
    this.retainedCount = state.entries.length;
    this.nextWriteIndex = this.retainedCount % this.capacity;

    const active = state.active;
    if (active === null) return;
    validateFiniteBurnEntry(active.entry, 'active burn');
    if (!Number.isFinite(active.startEnergyJ) || !Number.isFinite(active.startProperDeltaVMS)) {
      throw new RangeError('active burn starting ledger values must be finite');
    }
    validateVector(active.startVectorMS, 'active burn starting vector');
    validateVector(active.progradeBasis, 'active burn prograde basis');
    validateVector(active.normalBasis, 'active burn normal basis');
    validateVector(active.radialBasis, 'active burn radial basis');
    copyBurnEntry(this.activeEntry, active.entry);
    this.startEnergyJ = active.startEnergyJ;
    this.startProperDeltaVMS = active.startProperDeltaVMS;
    this.startVectorMS.set(active.startVectorMS);
    this.progradeBasis.set(active.progradeBasis);
    this.normalBasis.set(active.normalBasis);
    this.radialBasis.set(active.radialBasis);
    this.isActive = true;
  }
}

class ReadOnlyBurnLog implements BurnLogView {
  constructor(private readonly storage: BurnLogStorage) {}

  get capacity(): number {
    return this.storage.capacity;
  }

  get count(): number {
    return this.storage.count;
  }

  get activeBurn(): BurnLogEntry | null {
    return this.storage.activeBurn;
  }

  get(index: number): BurnLogEntry | null {
    return this.storage.get(index);
  }
}

/** Creates separate public-view and private-recorder capabilities at setup. */
export function createBurnLog(
  capacity = DEFAULT_BURN_LOG_CAPACITY,
  persistentState: BurnLogPersistentState | null = null,
): BurnLogController {
  const storage = new BurnLogStorage(capacity, persistentState);
  return {
    view: Object.freeze(new ReadOnlyBurnLog(storage)),
    recorder: storage,
    persistence: storage,
  };
}
