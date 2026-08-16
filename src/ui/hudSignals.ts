import { batch, computed, signal, type ReadonlySignal, type Signal } from '@preact/signals';

import {
  formatBodyId,
  formatDurationSec,
  formatEnergyWh,
  formatPowerW,
  formatProperDeltaV,
  formatUtcTimeMs,
} from '../core/formatUnits.js';
import type { WarpFactor } from '../core/time.js';
import {
  WarningFlag,
  WarpClampReason,
  type SimSnapshot,
  type WarpClampReason as WarpClampReasonCode,
} from '../sim/simulationSnapshot.js';
import { SPEED_OF_LIGHT_KM_S } from '../core/constants.js';
import type { CameraPose } from '../game/cameraDirector.js';
import { createBodyDisplayNames, createBodyRadiiKm } from '../game/hud/bodyMarkerCatalog.js';
import {
  BODY_LABEL_SLOT_COUNT,
  WORLD_MARKER_COMPONENTS,
  WorldMarkerIndex,
  createWorldMarkerBuffer,
  writeWorldMarkersInto,
  type WorldMarkerBuffer,
} from '../game/hud/worldMarkerModel.js';
import { createNavballProjectionBuffer } from './navballProjection.js';
import {
  commitNavballSignals,
  createNavballSignals,
  formatAttitudeMode,
  type NavballSignals,
} from './navballSignals.js';

const HUD_UPDATE_INTERVAL_MS = 100;
/** Above this the flight strip switches from km/s to a fraction of c. */
const RELATIVISTIC_SPEED_THRESHOLD_KM_S = 0.01 * SPEED_OF_LIGHT_KM_S;
/** Below this the flight strip reads in m/s (spec §7 "context units"). */
const METRES_PER_SECOND_THRESHOLD_KM_S = 1;
const ORBIT_NUMBER_FORMAT = new Intl.NumberFormat('en-US', {
  maximumSignificantDigits: 6,
  useGrouping: true,
});
const SIGNED_SI_PREFIXES = Object.freeze(['', 'k', 'M', 'G', 'T', 'P', 'E', 'Z', 'Y'] as const);

export { formatDurationSec, formatUtcTimeMs } from '../core/formatUnits.js';

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
  readonly burnSummaryAvailable: Signal<boolean>;
  readonly burnSummaryActive: Signal<boolean>;
  readonly burnEnergySpentJ: Signal<number>;
  readonly burnProperDeltaVMS: Signal<number>;
  readonly targetBodyId: Signal<string | null>;
  readonly targetDistanceKm: Signal<number>;
  readonly targetRelativeSpeedKmS: Signal<number>;
  readonly navball: NavballSignals;
  /** T0112 Clean preset: speed relative to the dominant body. */
  readonly relativeSpeedKmS: Signal<number>;
  readonly throttle: Signal<number>;
  readonly speedFractionOfLight: Signal<number>;
  /** Height above the dominant body's mean surface, km; NaN when unavailable. */
  readonly radarAltitudeKm: Signal<number>;
  readonly warningFlags: Signal<number>;
  readonly impactOccurred: Signal<boolean>;
  readonly worldMarkers: WorldMarkerSignals;
}

/**
 * Per-marker leaf signals for the DOM overlay.
 *
 * Numeric, not formatted transforms: the view writes the `translate3d` so the
 * string is built at most once per changed marker per sample instead of once per
 * marker per sample.
 */
export interface WorldMarkerSlotSignals {
  readonly visible: Signal<boolean>;
  readonly xPx: Signal<number>;
  readonly yPx: Signal<number>;
  readonly behind: Signal<boolean>;
  readonly offscreen: Signal<boolean>;
}

export interface BodyLabelSlotSignals {
  readonly visible: Signal<boolean>;
  readonly xPx: Signal<number>;
  readonly yPx: Signal<number>;
  readonly name: Signal<string>;
  readonly distance: Signal<string>;
}

export interface WorldMarkerSignals {
  readonly target: WorldMarkerSlotSignals;
  readonly prograde: WorldMarkerSlotSignals;
  readonly retrograde: WorldMarkerSlotSignals;
  readonly targetDistance: Signal<string>;
  readonly labels: readonly BodyLabelSlotSignals[];
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
  readonly burnSummaryLabel: ReadonlySignal<string>;
  readonly burnEnergy: ReadonlySignal<string>;
  readonly burnProperDeltaV: ReadonlySignal<string>;
  readonly targetBody: ReadonlySignal<string>;
  readonly targetDistance: ReadonlySignal<string>;
  readonly targetRelativeSpeed: ReadonlySignal<string>;
  readonly nextClosestApproach: ReadonlySignal<string>;
  readonly attitudeMode: ReadonlySignal<string>;
  /** Context-unit speed for the Clean strip: m/s below 1 km/s, km/s below 0.01c, then %c. */
  readonly relativeSpeed: ReadonlySignal<string>;
  readonly throttlePercent: ReadonlySignal<string>;
  readonly radarAltitude: ReadonlySignal<string>;
  readonly flightWarning: ReadonlySignal<string>;
}

export interface HudSignalStore {
  readonly signals: HudSignals;
  readonly display: HudDisplaySignals;
  publish(snapshot: SimSnapshot, nowMs: number): boolean;
  /**
   * Projects the in-world markers for the sample `publish` just committed.
   *
   * Split from `publish` because the camera pose for a frame is written *after*
   * the HUD sample (`renderFrame` steps the sim, publishes the HUD, then runs
   * `CameraDirector.update`). Keeping both in one store is what satisfies the
   * "one 10 Hz publication path" constraint: the caller gates this on
   * `publish()` returning true, so both halves describe the same snapshot at the
   * same 100 ms tick. The snapshot is passed in, never retained — the buffer it
   * points at is reused after one intervening step.
   */
  publishWorldMarkers(
    snapshot: SimSnapshot,
    pose: CameraPose,
    widthPx: number,
    heightPx: number,
    labelsEnabled: boolean,
  ): void;
}

function formatWarp(warp: WarpFactor): string {
  return `${ORBIT_NUMBER_FORMAT.format(warp)}×`;
}

function formatSignedEnergyJ(valueJ: number): string {
  if (!Number.isFinite(valueJ)) return '—';
  const absoluteJ = Math.abs(valueJ);
  let prefixIndex =
    absoluteJ === 0
      ? 0
      : Math.min(SIGNED_SI_PREFIXES.length - 1, Math.max(0, Math.floor(Math.log10(absoluteJ) / 3)));
  let scaled = valueJ / 1_000 ** prefixIndex;
  if (Math.abs(scaled) >= 999.5 && prefixIndex < SIGNED_SI_PREFIXES.length - 1) {
    prefixIndex += 1;
    scaled /= 1_000;
  }
  const rounded = Number(scaled.toPrecision(3));
  const absoluteRounded = Math.abs(rounded);
  const integerDigits = absoluteRounded < 1 ? 1 : Math.floor(Math.log10(absoluteRounded)) + 1;
  return `${rounded.toFixed(Math.max(0, 3 - integerDigits))} ${SIGNED_SI_PREFIXES[prefixIndex]}J`;
}

function createMarkerSlotSignals(): WorldMarkerSlotSignals {
  return {
    visible: signal(false),
    xPx: signal(0),
    yPx: signal(0),
    behind: signal(false),
    offscreen: signal(false),
  };
}

function createBodyLabelSignals(): BodyLabelSlotSignals {
  return {
    visible: signal(false),
    xPx: signal(0),
    yPx: signal(0),
    name: signal(''),
    distance: signal(''),
  };
}

function createWorldMarkerSignals(): WorldMarkerSignals {
  const labels: BodyLabelSlotSignals[] = [];
  for (let slot = 0; slot < BODY_LABEL_SLOT_COUNT; slot += 1) {
    labels.push(createBodyLabelSignals());
  }
  return {
    target: createMarkerSlotSignals(),
    prograde: createMarkerSlotSignals(),
    retrograde: createMarkerSlotSignals(),
    targetDistance: signal(''),
    labels: Object.freeze(labels),
  };
}

/**
 * Speed in the unit the number deserves (spec §7 "context units").
 *
 * Below 1 km/s a docking manoeuvre reads in m/s; up to one percent of light the
 * interesting figure is km/s; past that the only number a pilot can reason about
 * is the fraction of c, and km/s would be six digits of noise.
 */
export function formatContextSpeedKmS(valueKmS: number): string {
  if (!Number.isFinite(valueKmS) || valueKmS < 0) return '—';
  if (valueKmS < METRES_PER_SECOND_THRESHOLD_KM_S) {
    return `${(valueKmS * 1_000).toFixed(valueKmS * 1_000 < 100 ? 1 : 0)} m/s`;
  }
  if (valueKmS < RELATIVISTIC_SPEED_THRESHOLD_KM_S) {
    return `${ORBIT_NUMBER_FORMAT.format(Number(valueKmS.toPrecision(4)))} km/s`;
  }
  return `${((valueKmS / SPEED_OF_LIGHT_KM_S) * 100).toFixed(3)} %c`;
}

/** Radar altitude above the dominant body's mean surface. */
export function formatAltitudeKm(valueKm: number): string {
  if (!Number.isFinite(valueKm)) return '—';
  if (Math.abs(valueKm) < 1) return `${(valueKm * 1_000).toFixed(0)} m`;
  return formatOrbitDistanceKm(valueKm);
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
    burnSummaryAvailable: signal(false),
    burnSummaryActive: signal(false),
    burnEnergySpentJ: signal(0),
    burnProperDeltaVMS: signal(0),
    targetBodyId: signal<string | null>(null),
    targetDistanceKm: signal(Number.NaN),
    targetRelativeSpeedKmS: signal(Number.NaN),
    navball: createNavballSignals(),
    relativeSpeedKmS: signal(Number.NaN),
    throttle: signal(0),
    speedFractionOfLight: signal(0),
    radarAltitudeKm: signal(Number.NaN),
    warningFlags: signal(0),
    impactOccurred: signal(false),
    worldMarkers: createWorldMarkerSignals(),
  };
}

function createDisplaySignals(signals: HudSignals): HudDisplaySignals {
  // Shared by the Engineer warp panel and the Clean flight strip's warning line,
  // so the two can never disagree about why warp is clamped.
  const warpClamp = computed(() => {
    switch (signals.warpClampReason.value) {
      case WarpClampReason.INTEGRATION_BUDGET:
        return `Gravity well · integration budget · ${formatWarp(signals.effectiveWarp.value)} sustainable`;
      case WarpClampReason.THRUST_LOCKOUT:
        return 'Coast only · thrust locked above 1,000×';
      default:
        return '';
    }
  });
  return {
    requestedWarp: computed(() => formatWarp(signals.requestedWarp.value)),
    effectiveWarp: computed(() => formatWarp(signals.effectiveWarp.value)),
    warpClamp,
    dominantBody: computed(() => formatBodyId(signals.dominantBodyId.value)),
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
    burnSummaryLabel: computed(() => {
      if (!signals.burnSummaryAvailable.value) return 'No burns yet';
      return signals.burnSummaryActive.value ? 'Active burn' : 'Last burn';
    }),
    burnEnergy: computed(() =>
      signals.burnSummaryAvailable.value ? formatEnergyWh(signals.burnEnergySpentJ.value) : '—',
    ),
    burnProperDeltaV: computed(() =>
      signals.burnSummaryAvailable.value
        ? formatProperDeltaV(signals.burnProperDeltaVMS.value)
        : '—',
    ),
    targetBody: computed(() => formatBodyId(signals.targetBodyId.value)),
    targetDistance: computed(() => formatOrbitDistanceKm(signals.targetDistanceKm.value)),
    targetRelativeSpeed: computed(() =>
      formatRelativeSpeedKmS(signals.targetRelativeSpeedKmS.value),
    ),
    nextClosestApproach: computed(() =>
      signals.targetBodyId.value === null ? '—' : 'Awaiting trajectory predictor',
    ),
    attitudeMode: computed(() => formatAttitudeMode(signals.navball.attitudeMode.value)),
    relativeSpeed: computed(() => formatContextSpeedKmS(signals.relativeSpeedKmS.value)),
    throttlePercent: computed(() => `${Math.round(signals.throttle.value * 100).toFixed(0)}%`),
    radarAltitude: computed(() => formatAltitudeKm(signals.radarAltitudeKm.value)),
    flightWarning: computed(() => {
      if (signals.impactOccurred.value) return 'Surface contact — recover or respawn';
      if ((signals.warningFlags.value & WarningFlag.IMPACT) !== 0) return 'Surface contact';
      return warpClamp.value;
    }),
  };
}

class SampledHudSignalStore implements HudSignalStore {
  readonly signals = createSignals();
  readonly display = createDisplaySignals(this.signals);

  private lastPublishMs = Number.NEGATIVE_INFINITY;
  private pendingSnapshot: SimSnapshot | null = null;
  private readonly commitCallback: () => void;
  private readonly navballProjection = createNavballProjectionBuffer();
  private readonly worldMarkers: WorldMarkerBuffer = createWorldMarkerBuffer();
  private readonly bodyRadiiKm: Float64Array;
  private readonly bodyDisplayNames: readonly string[];
  private readonly markerCommitCallback: () => void;
  private pendingPose: CameraPose | null = null;
  private pendingWidthPx = 0;
  private pendingHeightPx = 0;
  private pendingLabelsEnabled = false;

  constructor(bodyRadiiKm: Float64Array, bodyDisplayNames: readonly string[]) {
    this.bodyRadiiKm = bodyRadiiKm;
    this.bodyDisplayNames = bodyDisplayNames;
    this.commitCallback = this.commitPendingSnapshot.bind(this);
    this.markerCommitCallback = this.commitPendingMarkers.bind(this);
  }

  publishWorldMarkers(
    snapshot: SimSnapshot,
    pose: CameraPose,
    widthPx: number,
    heightPx: number,
    labelsEnabled: boolean,
  ): void {
    this.pendingSnapshot = snapshot;
    this.pendingPose = pose;
    this.pendingWidthPx = widthPx;
    this.pendingHeightPx = heightPx;
    this.pendingLabelsEnabled = labelsEnabled;
    batch(this.markerCommitCallback);
    this.pendingSnapshot = null;
    this.pendingPose = null;
  }

  private commitPendingMarkers(): void {
    const snapshot = this.pendingSnapshot;
    const pose = this.pendingPose;
    if (snapshot === null || pose === null) {
      throw new Error('HUD marker commit requires pending data');
    }
    const markers = writeWorldMarkersInto(
      this.worldMarkers,
      snapshot,
      pose,
      this.pendingWidthPx,
      this.pendingHeightPx,
      this.pendingLabelsEnabled,
    );
    const signals = this.signals.worldMarkers;
    commitMarkerSlot(signals.target, markers, WorldMarkerIndex.TARGET);
    commitMarkerSlot(signals.prograde, markers, WorldMarkerIndex.PROGRADE);
    commitMarkerSlot(signals.retrograde, markers, WorldMarkerIndex.RETROGRADE);
    signals.targetDistance.value =
      markers.targetBodyIndex < 0 ? '' : formatOrbitDistanceKm(markers.targetDistanceKm);
    for (let slot = 0; slot < signals.labels.length; slot += 1) {
      const label = signals.labels[slot] as BodyLabelSlotSignals;
      if (slot >= markers.labelCount) {
        label.visible.value = false;
        continue;
      }
      const bodyIndex = markers.labelBodyIndices[slot] as number;
      label.visible.value = true;
      label.xPx.value = markers.labelPixels[slot * 2] as number;
      label.yPx.value = markers.labelPixels[slot * 2 + 1] as number;
      label.name.value =
        this.bodyDisplayNames[bodyIndex] ?? formatBodyId(snapshot.bodyIds[bodyIndex] ?? null);
      label.distance.value = formatOrbitDistanceKm(markers.labelDistancesKm[slot] as number);
    }
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
    commitNavballSignals(this.signals.navball, this.navballProjection, snapshot);
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
    this.signals.burnSummaryAvailable.value = snapshot.burnSummaryAvailable;
    this.signals.burnSummaryActive.value = snapshot.burnSummaryActive;
    this.signals.burnEnergySpentJ.value = snapshot.burnEnergySpentJ;
    this.signals.burnProperDeltaVMS.value = snapshot.burnProperDeltaVMS;
    this.signals.throttle.value = snapshot.throttle;
    this.signals.speedFractionOfLight.value = snapshot.speedFractionOfLight;
    this.signals.warningFlags.value = snapshot.warningFlags;
    this.signals.impactOccurred.value = snapshot.impactOccurred === 1;
    this.commitDominantBodyDerived(snapshot, dominantBodyIndex);
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

  /**
   * Speed and radar altitude against the dominant body.
   *
   * The same frame the navball's prograde marker uses. "Speed" on a flight HUD
   * has to mean speed relative to the thing you might hit; the heliocentric
   * figure is in the Engineer state-vector triad for anyone who wants it.
   */
  private commitDominantBodyDerived(snapshot: SimSnapshot, dominantBodyIndex: number): void {
    if (dominantBodyIndex < 0 || dominantBodyIndex >= snapshot.bodyIds.length) {
      this.signals.relativeSpeedKmS.value = Number.NaN;
      this.signals.radarAltitudeKm.value = Number.NaN;
      return;
    }
    const offset = dominantBodyIndex * 3;
    this.signals.relativeSpeedKmS.value = Math.hypot(
      (snapshot.shipCoordinateVelocityKmS[0] as number) -
        (snapshot.bodyVelocitiesKmS[offset] as number),
      (snapshot.shipCoordinateVelocityKmS[1] as number) -
        (snapshot.bodyVelocitiesKmS[offset + 1] as number),
      (snapshot.shipCoordinateVelocityKmS[2] as number) -
        (snapshot.bodyVelocitiesKmS[offset + 2] as number),
    );
    const radiusKm = this.bodyRadiiKm[dominantBodyIndex];
    if (radiusKm === undefined || !(radiusKm > 0)) {
      this.signals.radarAltitudeKm.value = Number.NaN;
      return;
    }
    const distanceKm = Math.hypot(
      (snapshot.shipState[0] as number) - (snapshot.bodyPositionsKm[offset] as number),
      (snapshot.shipState[1] as number) - (snapshot.bodyPositionsKm[offset + 1] as number),
      (snapshot.shipState[2] as number) - (snapshot.bodyPositionsKm[offset + 2] as number),
    );
    this.signals.radarAltitudeKm.value = distanceKm - radiusKm;
  }
}

function commitMarkerSlot(
  slot: WorldMarkerSlotSignals,
  markers: WorldMarkerBuffer,
  index: WorldMarkerIndex,
): void {
  const offset = index * WORLD_MARKER_COMPONENTS;
  const visible = markers.valid && (markers.markers[offset] as number) === 1;
  slot.visible.value = visible;
  if (!visible) return;
  slot.xPx.value = markers.markers[offset + 1] as number;
  slot.yPx.value = markers.markers[offset + 2] as number;
  slot.behind.value = (markers.markers[offset + 3] as number) === 1;
  slot.offscreen.value = (markers.markers[offset + 4] as number) === 1;
}

/**
 * Creates one setup-time HUD signal graph and its 10 Hz snapshot publisher.
 *
 * Mean radii and display names are static catalog facts; they are injected so
 * the store never reaches for a module-level singleton, and they default to the
 * shipped catalog so every existing caller (tests and the browser harnesses
 * included) keeps working unchanged.
 */
export function createHudSignalStore(
  bodyRadiiKm: Float64Array = createBodyRadiiKm(),
  bodyDisplayNames: readonly string[] = createBodyDisplayNames(),
): HudSignalStore {
  return new SampledHudSignalStore(bodyRadiiKm, bodyDisplayNames);
}
