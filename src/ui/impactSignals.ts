import { batch, computed, signal, type ReadonlySignal, type Signal } from '@preact/signals';

import { formatBodyId, formatDurationSec, formatUtcTimeMs } from '../core/formatUnits.js';
import type { SimSnapshot } from '../sim/simulationSnapshot.js';

const SPEED_FORMAT = new Intl.NumberFormat('en-US', { maximumSignificantDigits: 4 });

interface ImpactSignals {
  readonly occurred: Signal<boolean>;
  readonly bodyId: Signal<string | null>;
  readonly speedKmS: Signal<number>;
  readonly simTimeSec: Signal<number>;
  readonly utcTimeMs: Signal<number>;
  readonly properTimeSec: Signal<number>;
  readonly restorePointsAvailable: Signal<number>;
}

/** Strings the freeze overlay renders; every one is a leaf-node signal update. */
export interface ImpactDisplaySignals {
  readonly visible: ReadonlySignal<boolean>;
  readonly body: ReadonlySignal<string>;
  readonly speed: ReadonlySignal<string>;
  readonly missionElapsedTime: ReadonlySignal<string>;
  readonly coordinateUtc: ReadonlySignal<string>;
  readonly restoreEnabled: ReadonlySignal<boolean>;
  readonly restoreLabel: ReadonlySignal<string>;
}

export interface ImpactSignalStore {
  readonly display: ImpactDisplaySignals;
  /** Publishes a frame; returns whether anything changed. Allocation-free. */
  publish(snapshot: SimSnapshot, restorePointsAvailable: number): boolean;
}

/** m/s below 1 km/s, so a slow touchdown does not read as "0 km/s". */
function formatImpactSpeed(speedKmS: number): string {
  if (!Number.isFinite(speedKmS) || speedKmS < 0) return '—';
  if (speedKmS < 1) return `${SPEED_FORMAT.format(speedKmS * 1_000)} m/s`;
  return `${SPEED_FORMAT.format(speedKmS)} km/s`;
}

function createSignals(): ImpactSignals {
  return {
    occurred: signal(false),
    bodyId: signal<string | null>(null),
    speedKmS: signal(Number.NaN),
    simTimeSec: signal(Number.NaN),
    utcTimeMs: signal(Number.NaN),
    properTimeSec: signal(Number.NaN),
    restorePointsAvailable: signal(0),
  };
}

function createDisplay(signals: ImpactSignals): ImpactDisplaySignals {
  return {
    visible: computed(() => signals.occurred.value),
    body: computed(() => formatBodyId(signals.bodyId.value)),
    speed: computed(() => formatImpactSpeed(signals.speedKmS.value)),
    missionElapsedTime: computed(() => formatDurationSec(signals.properTimeSec.value)),
    coordinateUtc: computed(() => formatUtcTimeMs(signals.utcTimeMs.value)),
    restoreEnabled: computed(() => signals.restorePointsAvailable.value > 0),
    restoreLabel: computed(() =>
      signals.restorePointsAvailable.value > 0
        ? 'Restore last checkpoint'
        : 'No checkpoint available',
    ),
  };
}

class DefaultImpactSignalStore implements ImpactSignalStore {
  private readonly signals = createSignals();
  readonly display = createDisplay(this.signals);
  private pendingSnapshot: SimSnapshot | null = null;
  private pendingRestorePoints = 0;
  private readonly commitCallback: () => void;

  constructor() {
    this.commitCallback = this.commit.bind(this);
  }

  publish(snapshot: SimSnapshot, restorePointsAvailable: number): boolean {
    const occurred = snapshot.impactOccurred === 1;
    // The overlay is a rare, latched state: skip the batch entirely on the
    // overwhelmingly common frame where nothing about it has changed.
    if (
      !occurred &&
      !this.signals.occurred.value &&
      restorePointsAvailable === this.signals.restorePointsAvailable.value
    ) {
      return false;
    }
    if (
      occurred &&
      this.signals.occurred.value &&
      snapshot.impactSimTimeSec === this.signals.simTimeSec.value &&
      restorePointsAvailable === this.signals.restorePointsAvailable.value
    ) {
      return false;
    }
    this.pendingSnapshot = snapshot;
    this.pendingRestorePoints = restorePointsAvailable;
    batch(this.commitCallback);
    this.pendingSnapshot = null;
    return true;
  }

  private commit(): void {
    const snapshot = this.pendingSnapshot;
    if (snapshot === null) throw new Error('impact snapshot commit requires pending data');
    const bodyIndex = snapshot.impactBodyIndex;
    this.signals.occurred.value = snapshot.impactOccurred === 1;
    this.signals.bodyId.value = bodyIndex < 0 ? null : (snapshot.bodyIds[bodyIndex] ?? null);
    this.signals.speedKmS.value = snapshot.impactSpeedKmS;
    this.signals.simTimeSec.value = snapshot.impactSimTimeSec;
    this.signals.utcTimeMs.value = snapshot.utcTimeMs;
    this.signals.properTimeSec.value = snapshot.shipProperTimeSec;
    this.signals.restorePointsAvailable.value = this.pendingRestorePoints;
  }
}

/** Creates the freeze-overlay presentation for surface contact (ADR-036). */
export function createImpactSignalStore(): ImpactSignalStore {
  return new DefaultImpactSignalStore();
}
