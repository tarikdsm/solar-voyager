import { batch, computed, signal, type ReadonlySignal, type Signal } from '@preact/signals';

import type { SimSnapshot } from '../sim/simulationSnapshot.js';

const HUD_UPDATE_INTERVAL_MS = 100;
const ORBIT_NUMBER_FORMAT = new Intl.NumberFormat('en-US', {
  maximumSignificantDigits: 6,
  useGrouping: true,
});

export interface HudSignals {
  readonly orbitValid: Signal<boolean>;
  readonly dominantBodyId: Signal<string | null>;
  readonly apoapsisRadiusKm: Signal<number>;
  readonly periapsisRadiusKm: Signal<number>;
  readonly eccentricity: Signal<number>;
  readonly inclinationRad: Signal<number>;
  readonly periodSec: Signal<number>;
  readonly utcTimeMs: Signal<number>;
  readonly shipProperTimeSec: Signal<number>;
  readonly gamma: Signal<number>;
}

export interface HudDisplaySignals {
  readonly dominantBody: ReadonlySignal<string>;
  readonly apoapsis: ReadonlySignal<string>;
  readonly periapsis: ReadonlySignal<string>;
  readonly eccentricity: ReadonlySignal<string>;
  readonly inclination: ReadonlySignal<string>;
  readonly period: ReadonlySignal<string>;
  readonly coordinateUtc: ReadonlySignal<string>;
  readonly missionElapsedTime: ReadonlySignal<string>;
  readonly gamma: ReadonlySignal<string>;
}

export interface HudSignalStore {
  readonly signals: HudSignals;
  readonly display: HudDisplaySignals;
  publish(snapshot: SimSnapshot, nowMs: number): boolean;
}

function titleCaseBodyId(bodyId: string | null): string {
  if (bodyId === null || bodyId.length === 0) return '—';
  return bodyId.replace(
    /(^|[-_])(\p{L})/gu,
    (_match, separator: string, letter: string) =>
      `${separator.length === 0 ? '' : ' '}${letter.toUpperCase()}`,
  );
}

function padInteger(value: number, width: number): string {
  return Math.trunc(value).toString().padStart(width, '0');
}

/** Formats an osculating radius without changing the underlying simulation value. */
export function formatOrbitDistanceKm(valueKm: number): string {
  if (valueKm === Number.POSITIVE_INFINITY) return '∞';
  if (!Number.isFinite(valueKm)) return '—';
  if (Math.abs(valueKm) >= 1_000_000) {
    return `${ORBIT_NUMBER_FORMAT.format(valueKm / 1_000_000)} Mkm`;
  }
  return `${ORBIT_NUMBER_FORMAT.format(valueKm)} km`;
}

/** Formats a nonnegative duration as Dd HH:MM:SS.mmm. */
export function formatDurationSec(valueSec: number): string {
  if (valueSec === Number.POSITIVE_INFINITY) return '∞';
  if (!Number.isFinite(valueSec) || valueSec < 0) return '—';
  const totalMilliseconds = Math.round(valueSec * 1_000);
  const milliseconds = totalMilliseconds % 1_000;
  const totalSeconds = Math.floor(totalMilliseconds / 1_000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const totalHours = Math.floor(totalMinutes / 60);
  const hours = totalHours % 24;
  const days = Math.floor(totalHours / 24);
  const clock = `${padInteger(hours, 2)}:${padInteger(minutes, 2)}:${padInteger(seconds, 2)}.${padInteger(milliseconds, 3)}`;
  return days === 0 ? clock : `${days}d ${clock}`;
}

/** Formats the snapshot's display timestamp independently of local timezone. */
export function formatUtcTimeMs(utcTimeMs: number): string {
  if (!Number.isFinite(utcTimeMs)) return '—';
  return new Date(utcTimeMs).toISOString().replace('T', ' ').replace('Z', ' UTC');
}

function createSignals(): HudSignals {
  return {
    orbitValid: signal(false),
    dominantBodyId: signal<string | null>(null),
    apoapsisRadiusKm: signal(Number.NaN),
    periapsisRadiusKm: signal(Number.NaN),
    eccentricity: signal(Number.NaN),
    inclinationRad: signal(Number.NaN),
    periodSec: signal(Number.NaN),
    utcTimeMs: signal(Number.NaN),
    shipProperTimeSec: signal(Number.NaN),
    gamma: signal(1),
  };
}

function createDisplaySignals(signals: HudSignals): HudDisplaySignals {
  return {
    dominantBody: computed(() => titleCaseBodyId(signals.dominantBodyId.value)),
    apoapsis: computed(() =>
      signals.orbitValid.value ? formatOrbitDistanceKm(signals.apoapsisRadiusKm.value) : '—',
    ),
    periapsis: computed(() =>
      signals.orbitValid.value ? formatOrbitDistanceKm(signals.periapsisRadiusKm.value) : '—',
    ),
    eccentricity: computed(() =>
      signals.orbitValid.value && Number.isFinite(signals.eccentricity.value)
        ? signals.eccentricity.value.toFixed(6)
        : '—',
    ),
    inclination: computed(() =>
      signals.orbitValid.value && Number.isFinite(signals.inclinationRad.value)
        ? `${((signals.inclinationRad.value * 180) / Math.PI).toFixed(3)}°`
        : '—',
    ),
    period: computed(() =>
      signals.orbitValid.value ? formatDurationSec(signals.periodSec.value) : '—',
    ),
    coordinateUtc: computed(() => formatUtcTimeMs(signals.utcTimeMs.value)),
    missionElapsedTime: computed(() => formatDurationSec(signals.shipProperTimeSec.value)),
    gamma: computed(() =>
      signals.gamma.value > 1.001 ? `γ ${signals.gamma.value.toFixed(6)}` : '',
    ),
  };
}

class SampledHudSignalStore implements HudSignalStore {
  readonly signals = createSignals();
  readonly display = createDisplaySignals(this.signals);

  private lastPublishMs = Number.NEGATIVE_INFINITY;
  private pendingSnapshot: SimSnapshot | null = null;
  private readonly commitCallback: () => void;

  constructor() {
    this.commitCallback = this.commitPendingSnapshot.bind(this);
  }

  publish(snapshot: SimSnapshot, nowMs: number): boolean {
    if (!Number.isFinite(nowMs)) throw new RangeError('HUD sample time must be finite');
    const elapsedMs = nowMs - this.lastPublishMs;
    if (elapsedMs >= 0 && elapsedMs < HUD_UPDATE_INTERVAL_MS) return false;

    this.lastPublishMs = nowMs;
    this.pendingSnapshot = snapshot;
    batch(this.commitCallback);
    this.pendingSnapshot = null;
    return true;
  }

  private commitPendingSnapshot(): void {
    const snapshot = this.pendingSnapshot;
    if (snapshot === null) throw new Error('HUD snapshot commit requires pending data');
    const elements = snapshot.osculatingElements;
    const dominantBodyIndex = snapshot.dominantBodyIndex;
    this.signals.orbitValid.value = elements.valid;
    this.signals.dominantBodyId.value =
      dominantBodyIndex < 0 ? null : (snapshot.bodyIds[dominantBodyIndex] ?? null);
    this.signals.apoapsisRadiusKm.value = elements.apoapsisRadiusKm;
    this.signals.periapsisRadiusKm.value = elements.periapsisRadiusKm;
    this.signals.eccentricity.value = elements.eccentricity;
    this.signals.inclinationRad.value = elements.inclinationRad;
    this.signals.periodSec.value = elements.periodSec;
    this.signals.utcTimeMs.value = snapshot.utcTimeMs;
    this.signals.shipProperTimeSec.value = snapshot.shipProperTimeSec;
    this.signals.gamma.value = snapshot.gamma;
  }
}

/** Creates one setup-time HUD signal graph and its 10 Hz snapshot publisher. */
export function createHudSignalStore(): HudSignalStore {
  return new SampledHudSignalStore();
}
