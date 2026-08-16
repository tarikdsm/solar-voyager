import type { ReadonlyVec3 } from '../core/vec3.js';
import type { ExposureMode } from '../game/settings.js';

import type { ExposureSinkPort } from './lightingPostPipeline.js';
import { SUN_MAGNITUDE_AT_ONE_AU, apparentMagnitude } from './visualTier.js';

export type { ExposureMode };

/**
 * Scene key `K` in `E_target = clamp(K / L_scene, E_min, E_max)` (plan §3.5).
 *
 * `L_scene` is measured in solar constants at 1 AU, so `K = 1` reproduces v1's
 * fixed exposure of 1.0 exactly at Earth's heliocentric distance with nothing else
 * in view — the calibration every material, texture and reference capture in the
 * repository was authored against.
 */
export const EXPOSURE_KEY = 1;

/**
 * Exposure floor, −3 stops.
 *
 * Set by the photosphere, not by the irradiance: the Sun's disc renders at the
 * fixed `SUN_EMISSIVE_INTENSITY = 4` regardless of range, which ACES maps to 0.95
 * (flat white, granulation gone) at exposure 1. At 1/8 it maps to 0.56 — bright,
 * unclipped, granulation intact — while the corona billboard stays clearly visible.
 * Revisit together with the Sun's radiometric calibration in T0141.
 */
export const EXPOSURE_MIN = 0.125;

/**
 * Exposure ceiling, +4 stops.
 *
 * Bounded by `AMBIENT_LIGHT_INTENSITY = 0.02`, which `solarLighting.ts` never
 * rescales: above +4 stops that constant floor lifts night sides into grey cards.
 * At +4 it lifts Neptune's disc from ~2/255 (effectively black) to ~53/255, which
 * is what "Neptune daylight reads" buys.
 */
export const EXPOSURE_MAX = 16;

/** Exposure held in `fixed` mode — v1's value, so the mode is an exact rollback. */
export const FIXED_EXPOSURE = 1;

/** Slow direction: the scene darkened, exposure rises (plan §3.5). */
export const EXPOSURE_TAU_BRIGHT_TO_DARK_SEC = 6;

/** Fast direction: the scene brightened, exposure falls (plan §3.5). */
export const EXPOSURE_TAU_DARK_TO_BRIGHT_SEC = 2;

/**
 * Converts an apparent magnitude into illuminance at the observer, in units of the
 * solar constant at 1 AU (Pogson's ratio against the Sun's magnitude at 1 AU).
 *
 * Both terms of `L_scene` pass through here, which is what lets the inverse-square
 * solar term and the albedo × phase reflected term be added at all.
 */
export function solarIlluminanceRatio(magnitude: number): number {
  return Math.pow(10, 0.4 * (SUN_MAGNITUDE_AT_ONE_AU - magnitude));
}

export interface ExposureControllerOptions {
  /** The pipeline; the only module allowed to touch `toneMappingExposure`. */
  readonly sink: ExposureSinkPort;
  /** Shared packed heliocentric positions: catalog bodies first, then the ship. */
  readonly positionsKm: Float64Array;
  readonly sunIndex: number;
  readonly bodyRadiiKm: Float64Array;
  readonly bodyGeometricAlbedos: Float64Array;
  readonly mode?: ExposureMode;
}

function assertMode(mode: ExposureMode): void {
  if (mode !== 'auto' && mode !== 'fixed') {
    throw new RangeError(`Unknown exposure mode "${String(mode)}"; expected auto or fixed.`);
  }
}

/**
 * The single owner of `toneMappingExposure`: physically-motivated adaptive exposure
 * (plan §3.5, rendering-spec §4).
 *
 * Display-only by construction. It *consumes* `visualTier.apparentMagnitude`, the
 * same pure function the point-cloud ladder uses, and writes nothing back: the tier
 * ladder keeps deciding on physical magnitudes, and exposure never enters it.
 */
export class ExposureController {
  private readonly sink: ExposureSinkPort;
  private readonly positionsKm: Float64Array;
  private readonly sunIndex: number;
  private readonly bodyRadiiKm: Float64Array;
  private readonly bodyGeometricAlbedos: Float64Array;
  private readonly bodyCount: number;
  private readonly sunRadiusKm: number;

  private userMode: ExposureMode;
  private governorMode: ExposureMode = 'auto';
  private exposureValue = FIXED_EXPOSURE;
  private target = FIXED_EXPOSURE;
  private luminance = EXPOSURE_KEY;

  constructor(options: ExposureControllerOptions) {
    const { positionsKm, bodyRadiiKm, bodyGeometricAlbedos, sunIndex } = options;
    if (positionsKm.length === 0 || positionsKm.length % 3 !== 0) {
      throw new RangeError('Exposure positions must contain packed xyz triples.');
    }
    if (bodyRadiiKm.length === 0 || bodyRadiiKm.length * 3 > positionsKm.length) {
      throw new RangeError('Exposure body radii must index the packed positions.');
    }
    if (bodyGeometricAlbedos.length !== bodyRadiiKm.length) {
      throw new RangeError('Exposure body albedos must match the body radii length.');
    }
    if (!Number.isInteger(sunIndex) || sunIndex < 0 || sunIndex >= bodyRadiiKm.length) {
      throw new RangeError('Exposure sun index must address a catalogued body.');
    }
    const sunRadiusKm = bodyRadiiKm[sunIndex] as number;
    if (!Number.isFinite(sunRadiusKm) || sunRadiusKm <= 0) {
      throw new RangeError('Exposure sun radius must be positive and finite.');
    }
    if (options.mode !== undefined) assertMode(options.mode);

    this.sink = options.sink;
    this.positionsKm = positionsKm;
    this.sunIndex = sunIndex;
    this.bodyRadiiKm = bodyRadiiKm;
    this.bodyGeometricAlbedos = bodyGeometricAlbedos;
    this.bodyCount = bodyRadiiKm.length;
    this.sunRadiusKm = sunRadiusKm;
    this.userMode = options.mode ?? 'auto';
  }

  /** Effective mode: `fixed` from either the player setting or the governor wins. */
  get mode(): ExposureMode {
    return this.userMode === 'fixed' || this.governorMode === 'fixed' ? 'fixed' : 'auto';
  }

  /** The persisted player setting, independent of what the governor is doing. */
  get playerMode(): ExposureMode {
    return this.userMode;
  }

  /** The rung the governor last applied, independent of the player setting. */
  get qualityMode(): ExposureMode {
    return this.governorMode;
  }

  /** The adapted exposure currently written to the pipeline. */
  get exposure(): number {
    return this.exposureValue;
  }

  /** The clamped exposure the adaptation is heading for. */
  get targetExposure(): number {
    return this.target;
  }

  /** `L_scene`, in solar constants at 1 AU. Diagnostics and the pose tests. */
  get sceneLuminance(): number {
    return this.luminance;
  }

  setUserMode(mode: ExposureMode): void {
    assertMode(mode);
    this.userMode = mode;
  }

  /** The adaptive quality governor's rung; never overwrites the player setting. */
  setGovernorMode(mode: ExposureMode): void {
    assertMode(mode);
    this.governorMode = mode;
  }

  /**
   * Advances the adaptation by one frame and publishes the result.
   *
   * Allocation-free: two `apparentMagnitude` evaluations over the shared packed
   * array and scalar math (performance-spec §5).
   */
  update(wallDtSec: number, cameraPositionKm: ReadonlyVec3, dominantBodyIndex: number): void {
    if (!Number.isFinite(wallDtSec) || wallDtSec < 0) {
      throw new RangeError('Exposure wall delta must be finite and nonnegative.');
    }
    this.target = this.solveTarget(cameraPositionKm, dominantBodyIndex);
    if (wallDtSec > 0 && this.target !== this.exposureValue) {
      // First-order lag in log-exposure: equal time buys equal stops across the
      // whole 7-stop working range, which a lag on the exposure itself does not.
      const currentStops = Math.log2(this.exposureValue);
      const gapStops = Math.log2(this.target) - currentStops;
      const tauSec =
        gapStops > 0 ? EXPOSURE_TAU_BRIGHT_TO_DARK_SEC : EXPOSURE_TAU_DARK_TO_BRIGHT_SEC;
      this.exposureValue = Math.pow(
        2,
        currentStops + gapStops * (1 - Math.exp(-wallDtSec / tauSec)),
      );
    }
    this.sink.setExposure(this.exposureValue);
  }

  /**
   * Snaps to the target with no adaptation.
   *
   * For discontinuities where a fade would be a lie: startup, a restore-point
   * teleport, or a cruise insertion that moves the camera 30 AU in one frame.
   */
  reset(cameraPositionKm: ReadonlyVec3, dominantBodyIndex: number): void {
    this.target = this.solveTarget(cameraPositionKm, dominantBodyIndex);
    this.exposureValue = this.target;
    this.sink.setExposure(this.exposureValue);
  }

  private solveTarget(cameraPositionKm: ReadonlyVec3, dominantBodyIndex: number): number {
    // rendering-spec §4 — E_target = clamp(K / L_scene, E_min, E_max).
    let sceneLuminance = solarIlluminanceRatio(
      apparentMagnitude(
        this.sunIndex,
        this.sunIndex,
        this.sunRadiusKm,
        1,
        this.positionsKm,
        cameraPositionKm,
      ),
    );
    if (
      dominantBodyIndex >= 0 &&
      dominantBodyIndex < this.bodyCount &&
      dominantBodyIndex !== this.sunIndex
    ) {
      const radiusKm = this.bodyRadiiKm[dominantBodyIndex] as number;
      if (radiusKm > 0) {
        sceneLuminance += solarIlluminanceRatio(
          apparentMagnitude(
            dominantBodyIndex,
            this.sunIndex,
            radiusKm,
            this.bodyGeometricAlbedos[dominantBodyIndex] as number,
            this.positionsKm,
            cameraPositionKm,
          ),
        );
      }
    }
    this.luminance = sceneLuminance;
    if (this.mode === 'fixed') return FIXED_EXPOSURE;
    const unclamped = EXPOSURE_KEY / sceneLuminance;
    return unclamped < EXPOSURE_MIN
      ? EXPOSURE_MIN
      : unclamped > EXPOSURE_MAX
        ? EXPOSURE_MAX
        : unclamped;
  }
}
