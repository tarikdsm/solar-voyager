import { batch, computed, signal, type ReadonlySignal, type Signal } from '@preact/signals';

import type { TrajectoryEventSummary } from '../game/trajectoryPredictionModel.js';
import { formatDurationSec, formatOrbitDistanceKm } from './hudSignals.js';

const PREDICTION_NONE = 0;
const PREDICTION_PENDING = 1;
const PREDICTION_READY = 2;
const PREDICTION_ERROR = 3;
const TIME_SAMPLE_INTERVAL_MS = 100;

interface TrajectoryPredictionSignals {
  readonly status: Signal<number>;
  readonly targetSelected: Signal<boolean>;
  readonly closestApproachBodyIndex: Signal<number>;
  readonly closestApproachTimeSec: Signal<number>;
  readonly closestApproachDistanceKm: Signal<number>;
  readonly impactBodyIndex: Signal<number>;
  readonly impactTimeSec: Signal<number>;
  readonly impactBodyLabel: Signal<string>;
  readonly currentSimTimeSec: Signal<number>;
}

export interface TrajectoryPredictionDisplaySignals {
  readonly nextClosestApproach: ReadonlySignal<string>;
  readonly impactMessage: ReadonlySignal<string>;
  readonly impactVisible: ReadonlySignal<boolean>;
}

export interface TrajectoryPredictionSignalStore {
  readonly display: TrajectoryPredictionDisplaySignals;
  publishPending(targetBodyIndex: number): void;
  publishSuccess(
    summary: TrajectoryEventSummary,
    bodyIds: readonly string[],
    currentSimTimeSec: number,
  ): void;
  publishError(): void;
  publishTime(simTimeSec: number, nowMs: number): boolean;
}

function titleCaseBodyId(bodyId: string): string {
  return bodyId.replace(
    /(^|[-_])(\p{L})/gu,
    (_match, separator: string, letter: string) =>
      `${separator.length === 0 ? '' : ' '}${letter.toUpperCase()}`,
  );
}

function validateOptionalBodyIndex(label: string, bodyIndex: number, bodyCount: number): void {
  if (!Number.isInteger(bodyIndex) || bodyIndex < -1 || bodyIndex >= bodyCount) {
    throw new RangeError(`${label} body index is outside the canonical catalog`);
  }
}

function createSignals(): TrajectoryPredictionSignals {
  return {
    status: signal(PREDICTION_NONE),
    targetSelected: signal(false),
    closestApproachBodyIndex: signal(-1),
    closestApproachTimeSec: signal(Number.NaN),
    closestApproachDistanceKm: signal(Number.NaN),
    impactBodyIndex: signal(-1),
    impactTimeSec: signal(Number.NaN),
    impactBodyLabel: signal(''),
    currentSimTimeSec: signal(Number.NaN),
  };
}

function createDisplay(signals: TrajectoryPredictionSignals): TrajectoryPredictionDisplaySignals {
  return {
    nextClosestApproach: computed(() => {
      if (!signals.targetSelected.value) return '—';
      if (signals.status.value === PREDICTION_PENDING) return 'Calculating…';
      if (signals.status.value === PREDICTION_ERROR) return 'Prediction unavailable';
      if (signals.status.value !== PREDICTION_READY || signals.closestApproachBodyIndex.value < 0) {
        return '—';
      }
      const remainingSec = Math.max(
        0,
        signals.closestApproachTimeSec.value - signals.currentSimTimeSec.value,
      );
      return `${formatOrbitDistanceKm(signals.closestApproachDistanceKm.value)} · T−${formatDurationSec(remainingSec)}`;
    }),
    impactVisible: computed(
      () => signals.status.value === PREDICTION_READY && signals.impactBodyIndex.value >= 0,
    ),
    impactMessage: computed(() => {
      if (signals.status.value !== PREDICTION_READY || signals.impactBodyIndex.value < 0) return '';
      const remainingSec = Math.max(
        0,
        signals.impactTimeSec.value - signals.currentSimTimeSec.value,
      );
      return `${signals.impactBodyLabel.value} impact in ${formatDurationSec(remainingSec)}`;
    }),
  };
}

class DefaultTrajectoryPredictionSignalStore implements TrajectoryPredictionSignalStore {
  private readonly signals = createSignals();
  readonly display = createDisplay(this.signals);
  private lastTimePublishMs = Number.NEGATIVE_INFINITY;

  publishPending(targetBodyIndex: number): void {
    if (!Number.isInteger(targetBodyIndex) || targetBodyIndex < -1) {
      throw new RangeError('trajectory target body index must be an integer at least -1');
    }
    batch(() => {
      this.signals.status.value = targetBodyIndex < 0 ? PREDICTION_NONE : PREDICTION_PENDING;
      this.signals.targetSelected.value = targetBodyIndex >= 0;
      this.clearEvents();
    });
  }

  publishSuccess(
    summary: TrajectoryEventSummary,
    bodyIds: readonly string[],
    currentSimTimeSec: number,
  ): void {
    if (!Number.isFinite(currentSimTimeSec)) {
      throw new RangeError('trajectory simulation time must be finite');
    }
    validateOptionalBodyIndex('closest approach', summary.closestApproachBodyIndex, bodyIds.length);
    validateOptionalBodyIndex('impact', summary.impactBodyIndex, bodyIds.length);
    if (
      summary.closestApproachBodyIndex >= 0 &&
      (!Number.isFinite(summary.closestApproachTimeSec) ||
        !Number.isFinite(summary.closestApproachDistanceKm) ||
        summary.closestApproachDistanceKm < 0)
    ) {
      throw new RangeError('closest approach values must be finite and nonnegative');
    }
    if (summary.impactBodyIndex >= 0 && !Number.isFinite(summary.impactTimeSec)) {
      throw new RangeError('impact time must be finite');
    }
    const impactBodyId =
      summary.impactBodyIndex < 0 ? '' : (bodyIds[summary.impactBodyIndex] ?? '');
    if (summary.impactBodyIndex >= 0 && impactBodyId.length === 0) {
      throw new RangeError('impact body ID must be nonempty');
    }
    batch(() => {
      this.signals.status.value = PREDICTION_READY;
      this.signals.closestApproachBodyIndex.value = summary.closestApproachBodyIndex;
      this.signals.closestApproachTimeSec.value = summary.closestApproachTimeSec;
      this.signals.closestApproachDistanceKm.value = summary.closestApproachDistanceKm;
      this.signals.impactBodyIndex.value = summary.impactBodyIndex;
      this.signals.impactTimeSec.value = summary.impactTimeSec;
      this.signals.impactBodyLabel.value =
        impactBodyId.length === 0 ? '' : titleCaseBodyId(impactBodyId);
      this.signals.currentSimTimeSec.value = currentSimTimeSec;
    });
  }

  publishError(): void {
    batch(() => {
      this.signals.status.value = PREDICTION_ERROR;
      this.clearEvents();
    });
  }

  publishTime(simTimeSec: number, nowMs: number): boolean {
    if (!Number.isFinite(simTimeSec))
      throw new RangeError('trajectory simulation time must be finite');
    if (!Number.isFinite(nowMs)) throw new RangeError('trajectory sample time must be finite');
    const elapsedMs = nowMs - this.lastTimePublishMs;
    if (elapsedMs >= 0 && elapsedMs < TIME_SAMPLE_INTERVAL_MS) return false;
    this.lastTimePublishMs = nowMs;
    this.signals.currentSimTimeSec.value = simTimeSec;
    return true;
  }

  private clearEvents(): void {
    this.signals.closestApproachBodyIndex.value = -1;
    this.signals.closestApproachTimeSec.value = Number.NaN;
    this.signals.closestApproachDistanceKm.value = Number.NaN;
    this.signals.impactBodyIndex.value = -1;
    this.signals.impactTimeSec.value = Number.NaN;
    this.signals.impactBodyLabel.value = '';
  }
}

/** Creates the low-frequency HUD presentation for predictor results. */
export function createTrajectoryPredictionSignalStore(): TrajectoryPredictionSignalStore {
  return new DefaultTrajectoryPredictionSignalStore();
}
