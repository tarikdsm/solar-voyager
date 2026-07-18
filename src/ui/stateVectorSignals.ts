import { batch, computed, signal, type ReadonlySignal, type Signal } from '@preact/signals';

import { formatStateVectorMagnitude, StateVectorKind } from '../render/stateVectorModel.js';
import type { SimSnapshot } from '../sim/simulationSnapshot.js';

const SAMPLE_INTERVAL_MS = 100;
const PERCENT_C_FORMAT = new Intl.NumberFormat('en-US', {
  maximumSignificantDigits: 3,
  useGrouping: false,
});

export interface StateVectorSignals {
  readonly velocityKmS: Signal<number>;
  readonly accelerationKmS2: Signal<number>;
  readonly momentumKgKmS: Signal<number>;
  readonly angularMomentumKgKm2S: Signal<number>;
  readonly gamma: Signal<number>;
  readonly speedFractionOfLight: Signal<number>;
  readonly pinnedToEcliptic: Signal<boolean>;
}

export interface StateVectorDisplaySignals {
  readonly velocity: ReadonlySignal<string>;
  readonly acceleration: ReadonlySignal<string>;
  readonly momentum: ReadonlySignal<string>;
  readonly angularMomentum: ReadonlySignal<string>;
  readonly gamma: ReadonlySignal<string>;
  readonly speedFraction: ReadonlySignal<string>;
}

export interface StateVectorSignalStore {
  readonly signals: StateVectorSignals;
  readonly display: StateVectorDisplaySignals;
  publish(snapshot: SimSnapshot, nowMs: number): boolean;
  setPinnedToEcliptic(pinned: boolean): void;
}

function formatGamma(gamma: number): string {
  return Number.isFinite(gamma) && gamma >= 1 ? `γ ${gamma.toFixed(6)}` : '—';
}

function formatSpeedFraction(speedFractionOfLight: number): string {
  return Number.isFinite(speedFractionOfLight) && speedFractionOfLight >= 0
    ? `${PERCENT_C_FORMAT.format(speedFractionOfLight * 100)}% c`
    : '—';
}

class SampledStateVectorSignalStore implements StateVectorSignalStore {
  readonly signals: StateVectorSignals = {
    velocityKmS: signal(Number.NaN),
    accelerationKmS2: signal(Number.NaN),
    momentumKgKmS: signal(Number.NaN),
    angularMomentumKgKm2S: signal(Number.NaN),
    gamma: signal(Number.NaN),
    speedFractionOfLight: signal(Number.NaN),
    pinnedToEcliptic: signal(false),
  };

  readonly display: StateVectorDisplaySignals = {
    velocity: computed(() =>
      formatStateVectorMagnitude(StateVectorKind.VELOCITY, this.signals.velocityKmS.value),
    ),
    acceleration: computed(() =>
      formatStateVectorMagnitude(StateVectorKind.ACCELERATION, this.signals.accelerationKmS2.value),
    ),
    momentum: computed(() =>
      formatStateVectorMagnitude(StateVectorKind.MOMENTUM, this.signals.momentumKgKmS.value),
    ),
    angularMomentum: computed(() =>
      formatStateVectorMagnitude(
        StateVectorKind.ANGULAR_MOMENTUM,
        this.signals.angularMomentumKgKm2S.value,
      ),
    ),
    gamma: computed(() => formatGamma(this.signals.gamma.value)),
    speedFraction: computed(() => formatSpeedFraction(this.signals.speedFractionOfLight.value)),
  };

  private lastPublishMs = Number.NEGATIVE_INFINITY;
  private pendingSnapshot: SimSnapshot | null = null;
  private readonly commitCallback: () => void;

  constructor() {
    this.commitCallback = this.commitPendingSnapshot.bind(this);
  }

  publish(snapshot: SimSnapshot, nowMs: number): boolean {
    if (!Number.isFinite(nowMs)) throw new RangeError('State-vector sample time must be finite.');
    const elapsedMs = nowMs - this.lastPublishMs;
    if (elapsedMs >= 0 && elapsedMs < SAMPLE_INTERVAL_MS) return false;
    this.lastPublishMs = nowMs;
    this.pendingSnapshot = snapshot;
    batch(this.commitCallback);
    this.pendingSnapshot = null;
    return true;
  }

  setPinnedToEcliptic(pinned: boolean): void {
    this.signals.pinnedToEcliptic.value = pinned;
  }

  private commitPendingSnapshot(): void {
    const snapshot = this.pendingSnapshot;
    if (snapshot === null) throw new Error('State-vector commit requires pending snapshot data.');
    const velocity = snapshot.shipCmRelativeVelocityKmS;
    const acceleration = snapshot.shipProperAccelerationKmS2;
    const momentum = snapshot.shipRelativisticMomentumKgKmS;
    const angularMomentum = snapshot.shipAngularMomentumKgKm2S;
    this.signals.velocityKmS.value = Math.hypot(
      velocity[0] as number,
      velocity[1] as number,
      velocity[2] as number,
    );
    this.signals.accelerationKmS2.value = Math.hypot(
      acceleration[0] as number,
      acceleration[1] as number,
      acceleration[2] as number,
    );
    this.signals.momentumKgKmS.value = Math.hypot(
      momentum[0] as number,
      momentum[1] as number,
      momentum[2] as number,
    );
    this.signals.angularMomentumKgKm2S.value = Math.hypot(
      angularMomentum[0] as number,
      angularMomentum[1] as number,
      angularMomentum[2] as number,
    );
    this.signals.gamma.value = snapshot.gamma;
    this.signals.speedFractionOfLight.value = snapshot.speedFractionOfLight;
  }
}

/** Creates the stable 10 Hz signal graph for the state-vector DOM readouts. */
export function createStateVectorSignalStore(): StateVectorSignalStore {
  return new SampledStateVectorSignalStore();
}
