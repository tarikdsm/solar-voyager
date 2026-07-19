import { batch, computed, signal, type ReadonlySignal, type Signal } from '@preact/signals';

import {
  formatBodyId,
  formatDurationSec,
  formatEnergyWh,
  formatPowerW,
  formatProperDeltaV,
  formatSignedDeltaV,
  formatUtcTimeMs,
} from '../core/formatUnits.js';
import { tdbSecondsToUtcTimeMs } from '../core/time.js';
import {
  DEFAULT_BURN_LOG_CAPACITY,
  type BurnLogEntry,
  type BurnLogView,
} from '../sim/ship/ledger.js';

export interface BurnLogRowSignals {
  readonly startTimeSec: Signal<number>;
  readonly endTimeSec: Signal<number>;
  readonly startProperTimeSec: Signal<number>;
  readonly endProperTimeSec: Signal<number>;
  readonly energySpentJ: Signal<number>;
  readonly properDeltaVMS: Signal<number>;
  readonly peakPowerW: Signal<number>;
  readonly dominantBodyId: Signal<string | null>;
  readonly progradeDeltaVMS: Signal<number>;
  readonly normalDeltaVMS: Signal<number>;
  readonly radialDeltaVMS: Signal<number>;
}

export interface BurnLogRowDisplaySignals {
  readonly startUtc: ReadonlySignal<string>;
  readonly endUtc: ReadonlySignal<string>;
  readonly startMet: ReadonlySignal<string>;
  readonly endMet: ReadonlySignal<string>;
  readonly energy: ReadonlySignal<string>;
  readonly properDeltaV: ReadonlySignal<string>;
  readonly peakPower: ReadonlySignal<string>;
  readonly dominantBody: ReadonlySignal<string>;
  readonly progradeDeltaV: ReadonlySignal<string>;
  readonly normalDeltaV: ReadonlySignal<string>;
  readonly radialDeltaV: ReadonlySignal<string>;
}

export interface BurnLogRowSignalGraph {
  readonly visible: Signal<boolean>;
  readonly signals: BurnLogRowSignals;
  readonly display: BurnLogRowDisplaySignals;
}

export interface BurnLogSignalStore {
  readonly completedRows: readonly BurnLogRowSignalGraph[];
  readonly activeRow: BurnLogRowSignalGraph;
  readonly completedCount: Signal<number>;
  readonly publishCount: number;
  readonly structuralRebuildCount: number;
  publish(): boolean;
  rebind(view: BurnLogView): void;
}

function createRowSignals(): BurnLogRowSignals {
  return {
    startTimeSec: signal(0),
    endTimeSec: signal(0),
    startProperTimeSec: signal(0),
    endProperTimeSec: signal(0),
    energySpentJ: signal(0),
    properDeltaVMS: signal(0),
    peakPowerW: signal(0),
    dominantBodyId: signal<string | null>(null),
    progradeDeltaVMS: signal(0),
    normalDeltaVMS: signal(0),
    radialDeltaVMS: signal(0),
  };
}

function createRowDisplaySignals(signals: BurnLogRowSignals): BurnLogRowDisplaySignals {
  return {
    startUtc: computed(() => formatUtcTimeMs(tdbSecondsToUtcTimeMs(signals.startTimeSec.value))),
    endUtc: computed(() => formatUtcTimeMs(tdbSecondsToUtcTimeMs(signals.endTimeSec.value))),
    startMet: computed(() => formatDurationSec(signals.startProperTimeSec.value)),
    endMet: computed(() => formatDurationSec(signals.endProperTimeSec.value)),
    energy: computed(() => formatEnergyWh(signals.energySpentJ.value)),
    properDeltaV: computed(() => formatProperDeltaV(signals.properDeltaVMS.value)),
    peakPower: computed(() => formatPowerW(signals.peakPowerW.value)),
    dominantBody: computed(() => formatBodyId(signals.dominantBodyId.value)),
    progradeDeltaV: computed(() => formatSignedDeltaV(signals.progradeDeltaVMS.value)),
    normalDeltaV: computed(() => formatSignedDeltaV(signals.normalDeltaVMS.value)),
    radialDeltaV: computed(() => formatSignedDeltaV(signals.radialDeltaVMS.value)),
  };
}

function createRowSignalGraph(): BurnLogRowSignalGraph {
  const signals = createRowSignals();
  return {
    visible: signal(false),
    signals,
    display: createRowDisplaySignals(signals),
  };
}

function copyEntryToRow(row: BurnLogRowSignalGraph, entry: BurnLogEntry): void {
  const signals = row.signals;
  signals.startTimeSec.value = entry.startTimeSec;
  signals.endTimeSec.value = entry.endTimeSec;
  signals.startProperTimeSec.value = entry.startProperTimeSec;
  signals.endProperTimeSec.value = entry.endProperTimeSec;
  signals.energySpentJ.value = entry.energySpentJ;
  signals.properDeltaVMS.value = entry.properDeltaVMS;
  signals.peakPowerW.value = entry.peakPowerW;
  signals.dominantBodyId.value = entry.dominantBodyId;
  signals.progradeDeltaVMS.value = entry.progradeDeltaVMS;
  signals.normalDeltaVMS.value = entry.normalDeltaVMS;
  signals.radialDeltaVMS.value = entry.radialDeltaVMS;
  row.visible.value = true;
}

function clearRow(row: BurnLogRowSignalGraph): void {
  const signals = row.signals;
  signals.startTimeSec.value = 0;
  signals.endTimeSec.value = 0;
  signals.startProperTimeSec.value = 0;
  signals.endProperTimeSec.value = 0;
  signals.energySpentJ.value = 0;
  signals.properDeltaVMS.value = 0;
  signals.peakPowerW.value = 0;
  signals.dominantBodyId.value = null;
  signals.progradeDeltaVMS.value = 0;
  signals.normalDeltaVMS.value = 0;
  signals.radialDeltaVMS.value = 0;
  row.visible.value = false;
}

class PreallocatedBurnLogSignalStore implements BurnLogSignalStore {
  readonly completedRows: readonly BurnLogRowSignalGraph[];
  readonly activeRow = createRowSignalGraph();
  readonly completedCount = signal(0);

  private view: BurnLogView;
  private mutablePublishCount = 0;
  private mutableStructuralRebuildCount = 0;
  private cachedCount = -1;
  private cachedHasNewest = false;
  private cachedStartTimeSec = 0;
  private cachedEndTimeSec = 0;
  private cachedStartProperTimeSec = 0;
  private cachedEndProperTimeSec = 0;
  private cachedEnergySpentJ = 0;
  private cachedProperDeltaVMS = 0;
  private cachedPeakPowerW = 0;
  private cachedDominantBodyId: string | null = null;
  private cachedProgradeDeltaVMS = 0;
  private cachedNormalDeltaVMS = 0;
  private cachedRadialDeltaVMS = 0;
  private forceRebuild = false;
  private commitRebuilt = false;
  private readonly commitCallback: () => void;

  constructor(view: BurnLogView) {
    const rows: BurnLogRowSignalGraph[] = [];
    for (let index = 0; index < DEFAULT_BURN_LOG_CAPACITY; index += 1) {
      rows.push(createRowSignalGraph());
    }
    this.completedRows = rows;
    this.view = view;
    this.commitCallback = this.commit.bind(this);
    this.rebind(view);
  }

  get publishCount(): number {
    return this.mutablePublishCount;
  }

  get structuralRebuildCount(): number {
    return this.mutableStructuralRebuildCount;
  }

  publish(): boolean {
    this.mutablePublishCount += 1;
    this.forceRebuild = false;
    this.commitRebuilt = false;
    batch(this.commitCallback);
    return this.commitRebuilt;
  }

  rebind(view: BurnLogView): void {
    this.validateView(view);
    this.view = view;
    this.forceRebuild = true;
    this.commitRebuilt = false;
    batch(this.commitCallback);
  }

  private commit(): void {
    const count = this.view.count;
    this.validateCount(count, this.view.capacity);
    let newest: BurnLogEntry | null = null;
    if (count > 0) {
      newest = this.view.get(count - 1);
      if (newest === null) throw new Error('burn log newest entry is missing');
    }

    if (this.forceRebuild || this.historyChanged(count, newest)) {
      this.rebuildCompletedRows(count, newest);
      this.commitRebuilt = true;
    }

    const activeBurn = this.view.activeBurn;
    if (activeBurn === null) clearRow(this.activeRow);
    else copyEntryToRow(this.activeRow, activeBurn);
  }

  private historyChanged(count: number, newest: BurnLogEntry | null): boolean {
    if (count !== this.cachedCount) return true;
    if (newest === null) return this.cachedHasNewest;
    if (!this.cachedHasNewest) return true;
    return (
      newest.startTimeSec !== this.cachedStartTimeSec ||
      newest.endTimeSec !== this.cachedEndTimeSec ||
      newest.startProperTimeSec !== this.cachedStartProperTimeSec ||
      newest.endProperTimeSec !== this.cachedEndProperTimeSec ||
      newest.energySpentJ !== this.cachedEnergySpentJ ||
      newest.properDeltaVMS !== this.cachedProperDeltaVMS ||
      newest.peakPowerW !== this.cachedPeakPowerW ||
      newest.dominantBodyId !== this.cachedDominantBodyId ||
      newest.progradeDeltaVMS !== this.cachedProgradeDeltaVMS ||
      newest.normalDeltaVMS !== this.cachedNormalDeltaVMS ||
      newest.radialDeltaVMS !== this.cachedRadialDeltaVMS
    );
  }

  private rebuildCompletedRows(count: number, newest: BurnLogEntry | null): void {
    for (let rowIndex = 0; rowIndex < DEFAULT_BURN_LOG_CAPACITY; rowIndex += 1) {
      const row = this.completedRows[rowIndex];
      if (row === undefined) throw new Error('burn log completed row graph is sparse');
      if (rowIndex >= count) {
        clearRow(row);
        continue;
      }
      const entry = rowIndex === 0 ? newest : this.view.get(count - rowIndex - 1);
      if (entry === null) throw new Error('burn log completed history is sparse');
      copyEntryToRow(row, entry);
    }
    this.completedCount.value = count;
    this.cacheNewest(count, newest);
    this.mutableStructuralRebuildCount += 1;
  }

  private cacheNewest(count: number, newest: BurnLogEntry | null): void {
    this.cachedCount = count;
    if (newest === null) {
      this.cachedHasNewest = false;
      this.cachedDominantBodyId = null;
      return;
    }
    this.cachedHasNewest = true;
    this.cachedStartTimeSec = newest.startTimeSec;
    this.cachedEndTimeSec = newest.endTimeSec;
    this.cachedStartProperTimeSec = newest.startProperTimeSec;
    this.cachedEndProperTimeSec = newest.endProperTimeSec;
    this.cachedEnergySpentJ = newest.energySpentJ;
    this.cachedProperDeltaVMS = newest.properDeltaVMS;
    this.cachedPeakPowerW = newest.peakPowerW;
    this.cachedDominantBodyId = newest.dominantBodyId;
    this.cachedProgradeDeltaVMS = newest.progradeDeltaVMS;
    this.cachedNormalDeltaVMS = newest.normalDeltaVMS;
    this.cachedRadialDeltaVMS = newest.radialDeltaVMS;
  }

  private validateView(view: BurnLogView): void {
    const capacity = view.capacity;
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > DEFAULT_BURN_LOG_CAPACITY) {
      throw new RangeError('burn log UI capacity must be an integer from 1 through 256');
    }
    this.validateCount(view.count, capacity);
  }

  private validateCount(count: number, capacity: number): void {
    if (!Number.isInteger(count) || count < 0 || count > capacity) {
      throw new RangeError('burn log view count must fit its capacity');
    }
  }
}

/** Creates one bounded signal graph and synchronously binds its canonical history view. */
export function createBurnLogSignalStore(view: BurnLogView): BurnLogSignalStore {
  return new PreallocatedBurnLogSignalStore(view);
}
