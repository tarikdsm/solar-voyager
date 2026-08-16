/**
 * Navigation lights and the anti-collision beacon (T0122).
 *
 * T0121 already ships `mat_light_nav_l`, `mat_light_nav_r` and
 * `mat_light_beacon` with a low authored emissive strength, so the asset reads
 * "lights on" before this file exists. What belongs here is the *modulation*:
 * the authored value is cached at bind time and multiplied by a waveform, so a
 * re-authored asset changes the lights without changing this code.
 *
 * The waveforms take **simulation** time, not wall time. That is the whole point:
 * the frame loop holds `simTimeSec` while paused (T0112), so a paused game
 * freezes the strobe mid-flash exactly as T0128's clouds stop rotating. It also
 * means the beacon strobes faster under time warp, which is honest — it is a
 * sim-time phenomenon being watched through compressed time.
 */

import { MeshStandardMaterial, type Material } from 'three';

import {
  SHIP_BEACON_MATERIAL_NAME,
  SHIP_NAV_PORT_MATERIAL_NAME,
  SHIP_NAV_STARBOARD_MATERIAL_NAME,
} from './shipEffectAnchors.js';

/** Anti-collision double flash: two pulses per this many simulated seconds. */
export const BEACON_PERIOD_SEC = 1.6;

/** Gap between the two pulses of one flash, in simulated seconds. */
export const BEACON_DOUBLE_GAP_SEC = 0.22;

/** Half-width of one pulse, in simulated seconds. */
export const BEACON_PULSE_HALF_WIDTH_SEC = 0.045;

/** Peak multiplier over the authored emissive strength at the top of a pulse. */
export const BEACON_PEAK_MULTIPLIER = 6;

/** Residual glow between flashes, so the housing never reads as dead. */
export const BEACON_FLOOR_MULTIPLIER = 0.25;

/** Navigation lights breathe over this many simulated seconds. */
export const NAV_BREATHE_PERIOD_SEC = 4;

/** Depth of the navigation-light breathing, as a fraction of the authored value. */
export const NAV_BREATHE_DEPTH = 0.06;

/** Positive remainder, so negative simulation times phase correctly. */
function positiveModulo(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

/** One pulse: a raised cosine, zero outside its half-width. */
function pulse(distanceSec: number): number {
  const normalized = Math.abs(distanceSec) / BEACON_PULSE_HALF_WIDTH_SEC;
  if (normalized >= 1) return 0;
  return 0.5 * (1 + Math.cos(Math.PI * normalized));
}

/**
 * Beacon emissive multiplier at one simulated time.
 *
 * Two raised-cosine pulses `BEACON_DOUBLE_GAP_SEC` apart, repeating every
 * `BEACON_PERIOD_SEC`, over a low floor. Non-finite time holds the floor rather
 * than propagating a NaN into a material.
 */
export function beaconIntensityFactor(simTimeSec: number): number {
  if (!Number.isFinite(simTimeSec)) return BEACON_FLOOR_MULTIPLIER;
  const phase = positiveModulo(simTimeSec, BEACON_PERIOD_SEC);
  const peak = Math.max(
    pulse(phase),
    pulse(phase - BEACON_DOUBLE_GAP_SEC),
    // The first pulse of the next flash, so the wrap has no seam.
    pulse(phase - BEACON_PERIOD_SEC),
  );
  return BEACON_FLOOR_MULTIPLIER + (BEACON_PEAK_MULTIPLIER - BEACON_FLOOR_MULTIPLIER) * peak;
}

/** Navigation-light emissive multiplier: steady, with a slow shallow breath. */
export function navIntensityFactor(simTimeSec: number): number {
  if (!Number.isFinite(simTimeSec)) return 1;
  return 1 + NAV_BREATHE_DEPTH * Math.sin((2 * Math.PI * simTimeSec) / NAV_BREATHE_PERIOD_SEC);
}

interface BoundLight {
  readonly material: MeshStandardMaterial;
  readonly baseEmissiveIntensity: number;
  readonly beacon: boolean;
}

/** Drives the three authored light materials from simulation time. */
export class ShipLights {
  private readonly bound: BoundLight[] = [];
  private currentBeaconFactor = 0;
  private currentNavFactor = 0;

  /**
   * Adopts whichever of the three light materials the loaded model carries.
   *
   * Missing materials are not an error here: `ShipVisual` owns the asset
   * contract and `ShipEffects` reports the bound count, so a re-export that
   * drops a light shows up as `lightCount` in the browser gate instead of as a
   * throw inside a lazily-loaded model promise.
   */
  bind(materials: readonly Material[]): number {
    this.bound.length = 0;
    for (let index = 0; index < materials.length; index += 1) {
      const material = materials[index];
      if (!(material instanceof MeshStandardMaterial)) continue;
      const beacon = material.name === SHIP_BEACON_MATERIAL_NAME;
      const navigation =
        material.name === SHIP_NAV_PORT_MATERIAL_NAME ||
        material.name === SHIP_NAV_STARBOARD_MATERIAL_NAME;
      if (!beacon && !navigation) continue;
      this.bound.push({
        material,
        baseEmissiveIntensity: material.emissiveIntensity,
        beacon,
      });
    }
    return this.bound.length;
  }

  /** Releases the materials and restores their authored emissive strengths. */
  unbind(): void {
    for (let index = 0; index < this.bound.length; index += 1) {
      const light = this.bound[index];
      if (light === undefined) continue;
      light.material.emissiveIntensity = light.baseEmissiveIntensity;
    }
    this.bound.length = 0;
  }

  /** Writes one frame of blink. Allocation-free; a no-op before `bind`. */
  update(simTimeSec: number): void {
    const beaconFactor = beaconIntensityFactor(simTimeSec);
    const navFactor = navIntensityFactor(simTimeSec);
    this.currentBeaconFactor = beaconFactor;
    this.currentNavFactor = navFactor;
    for (let index = 0; index < this.bound.length; index += 1) {
      const light = this.bound[index];
      if (light === undefined) continue;
      light.material.emissiveIntensity =
        light.baseEmissiveIntensity * (light.beacon ? beaconFactor : navFactor);
    }
  }

  get boundCount(): number {
    return this.bound.length;
  }

  get beaconFactor(): number {
    return this.currentBeaconFactor;
  }

  get navFactor(): number {
    return this.currentNavFactor;
  }
}
