import { batch, computed, signal, type ReadonlySignal, type Signal } from '@preact/signals';

import { formatEnergyWh, formatPowerW } from '../core/formatUnits.js';
import type { WarpFactor } from '../core/time.js';
import {
  WarpClampReason,
  type SimSnapshot,
  type WarpClampReason as WarpClampReasonCode,
} from '../sim/simulationSnapshot.js';

const HUD_UPDATE_INTERVAL_MS = 100;
const ORBIT_NUMBER_FORMAT = new Intl.NumberFormat('en-US', {
  maximumSignificantDigits: 6,
  useGrouping: true,
});
const HUD_METRIC_FORMAT = new Intl.NumberFormat('en-US', {
  maximumSignificantDigits: 3,
  useGrouping: true,
});
const SIGNED_SI_PREFIXES = Object.freeze(['', 'k', 'M', 'G', 'T', 'P', 'E', 'Z', 'Y'] as const);

export interface HudSignals {
  readonly requestedWarp: Signal<WarpFactor>;
  readonly effectiveWarp: Signal<WarpFactor>;
  readonly warpClampReason: Signal<WarpClampReasonCode>;
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
  readonly energySpentJ: Signal<number>;
  readonly powerDrawW: Signal<number>;
  readonly properDeltaVMS: Signal<number>;
  readonly kineticEnergyChangeJ: Signal<number>;
  readonly targetBodyId: Signal<string | null>;
  readonly targetDistanceKm: Signal<number>;
  readonly targetRelativeSpeedKmS: Signal<number>;
}

export interface HudDisplaySignals {
  readonly requestedWarp: ReadonlySignal<string>;
  readonly effectiveWarp: ReadonlySignal<string>;
  readonly warpClamp: ReadonlySignal<string>;
  readonly dominantBody: ReadonlySignal<string>;
  readonly apoapsis: ReadonlySignal<string>;
  readonly periapsis: ReadonlySignal<string>;
  readonly eccentricity: ReadonlySignal<string>;
  readonly inclination: ReadonlySignal<string>;
  readonly period: ReadonlySignal<string>;
  readonly coordinateUtc: ReadonlySignal<string>;
  readonly missionElapsedTime: ReadonlySignal<string>;
  readonly gamma: ReadonlySignal<string>;
  readonly energySpent: ReadonlySignal<string>;
  readonly powerDraw: ReadonlySignal<string>;
  readonly properDeltaV: ReadonlySignal<string>;
  readonly kineticEnergyChange: ReadonlySignal<string>;
  readonly targetBody: ReadonlySignal<string>;
  readonly targetDistance: ReadonlySignal<string>;
  readonly targetRelativeSpeed: ReadonlySignal<string>;
  readonly nextClosestApproach: ReadonlySignal<string>;
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

function formatWarp(warp: WarpFactor): string {
  return `${ORBIT_NUMBER_FORMAT.format(warp)}×`;
}

function formatProperDeltaV(valueMS: number): string {
  if (!Number.isFinite(valueMS) || valueMS < 0) return '—';
  if (valueMS >= 1_000) return `${HUD_METRIC_FORMAT.format(valueMS / 1_000)} km/s`;
  return `${HUD_METRIC_FORMAT.format(valueMS)} m/s`;
}

function formatSignedEnergyJ(valueJ: number): string {
  if (!Number.isFinite(valueJ)) return '—';
  const absoluteJ = Math.abs(valueJ);
  const prefixIndex =
    absoluteJ === 0
      ? 0
      : Math.min(SIGNED_SI_PREFIXES.length - 1, Math.max(0, Math.floor(Math.log10(absoluteJ) / 3)));
  const scaled = valueJ / 1_000 ** prefixIndex;
  const rounded = Number(scaled.toPrecision(3));
  const absoluteRounded = Math.abs(rounded);
  const integerDigits = absoluteRounded < 1 ? 1 : Math.floor(Math.log10(absoluteRounded)) + 1;
  return `${rounded.toFixed(Math.max(0, 3 - integerDigits))} ${SIGNED_SI_PREFIXES[prefixIndex]}J`;
}

function formatRelativeSpeedKmS(valueKmS: number): string {
  return Number.isFinite(valueKmS) && valueKmS >= 0
    ? `${ORBIT_NUMBER_FORMAT.format(valueKmS)} km/s`
    : '—';
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
    requestedWarp: signal<WarpFactor>(1),
    effectiveWarp: signal<WarpFactor>(1),
    warpClampReason: signal<WarpClampReasonCode>(WarpClampReason.NONE),
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
    energySpentJ: signal(0),
    powerDrawW: signal(0),
    properDeltaVMS: signal(0),
    kineticEnergyChangeJ: signal(0),
    targetBodyId: signal<string | null>(null),
    targetDistanceKm: signal(Number.NaN),
    targetRelativeSpeedKmS: signal(Number.NaN),
  };
}

function createDisplaySignals(signals: HudSignals): HudDisplaySignals {
  return {
    requestedWarp: computed(() => formatWarp(signals.requestedWarp.value)),
    effectiveWarp: computed(() => formatWarp(signals.effectiveWarp.value)),
    warpClamp: computed(() => {
      switch (signals.warpClampReason.value) {
        case WarpClampReason.INTEGRATION_BUDGET:
          return `Gravity well · ${formatWarp(signals.effectiveWarp.value)} sustainable`;
        case WarpClampReason.THRUST_LOCKOUT:
          return 'Coast only · thrust locked above 1,000×';
        default:
          return '';
      }
    }),
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
    energySpent: computed(() => formatEnergyWh(signals.energySpentJ.value)),
    powerDraw: computed(() => formatPowerW(signals.powerDrawW.value)),
    properDeltaV: computed(() => formatProperDeltaV(signals.properDeltaVMS.value)),
    kineticEnergyChange: computed(() => formatSignedEnergyJ(signals.kineticEnergyChangeJ.value)),
    targetBody: computed(() => titleCaseBodyId(signals.targetBodyId.value)),
    targetDistance: computed(() => formatOrbitDistanceKm(signals.targetDistanceKm.value)),
    targetRelativeSpeed: computed(() =>
      formatRelativeSpeedKmS(signals.targetRelativeSpeedKmS.value),
    ),
    nextClosestApproach: computed(() =>
      signals.targetBodyId.value === null ? '—' : 'Awaiting trajectory predictor',
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
    this.signals.requestedWarp.value = snapshot.requestedWarp;
    this.signals.effectiveWarp.value = snapshot.effectiveWarp;
    this.signals.warpClampReason.value = snapshot.warpClampReason;
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
    this.signals.energySpentJ.value = snapshot.energySpentJ;
    this.signals.powerDrawW.value = snapshot.powerDrawW;
    this.signals.properDeltaVMS.value = snapshot.properDeltaVMS;
    this.signals.kineticEnergyChangeJ.value = snapshot.kineticEnergyChangeJ;
    const targetBodyIndex = snapshot.targetBodyIndex;
    if (targetBodyIndex < 0 || targetBodyIndex >= snapshot.bodyIds.length) {
      this.signals.targetBodyId.value = null;
      this.signals.targetDistanceKm.value = Number.NaN;
      this.signals.targetRelativeSpeedKmS.value = Number.NaN;
      return;
    }
    const offset = targetBodyIndex * 3;
    const dxKm = (snapshot.bodyPositionsKm[offset] as number) - (snapshot.shipState[0] as number);
    const dyKm =
      (snapshot.bodyPositionsKm[offset + 1] as number) - (snapshot.shipState[1] as number);
    const dzKm =
      (snapshot.bodyPositionsKm[offset + 2] as number) - (snapshot.shipState[2] as number);
    const dvxKmS =
      (snapshot.bodyVelocitiesKmS[offset] as number) -
      (snapshot.shipCoordinateVelocityKmS[0] as number);
    const dvyKmS =
      (snapshot.bodyVelocitiesKmS[offset + 1] as number) -
      (snapshot.shipCoordinateVelocityKmS[1] as number);
    const dvzKmS =
      (snapshot.bodyVelocitiesKmS[offset + 2] as number) -
      (snapshot.shipCoordinateVelocityKmS[2] as number);
    this.signals.targetBodyId.value =
      snapshot.targetBodyId ?? snapshot.bodyIds[targetBodyIndex] ?? null;
    this.signals.targetDistanceKm.value = Math.hypot(dxKm, dyKm, dzKm);
    this.signals.targetRelativeSpeedKmS.value = Math.hypot(dvxKmS, dvyKmS, dvzKmS);
  }
}

/** Creates one setup-time HUD signal graph and its 10 Hz snapshot publisher. */
export function createHudSignalStore(): HudSignalStore {
  return new SampledHudSignalStore();
}
