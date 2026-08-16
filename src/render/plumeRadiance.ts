/**
 * Photon-drive plume photometry (T0122; plan §3.6, rendering-spec §3.4).
 *
 * The drive is a photon rocket, so `P = m·alpha·c` (physics-spec §5) leaves the
 * ship as light and `SimSnapshot.powerDrawW` already publishes it every frame.
 * Everything here turns that one number, plus a viewing angle, into the same
 * apparent magnitude the rest of the renderer speaks — so a burning ship reaches
 * the screen through `visualTier`'s existing curve rather than through a second,
 * drifting brightness ladder.
 *
 * Pure functions, no three.js, no allocation.
 */

import { SUN_MAGNITUDE_AT_ONE_AU } from './visualTier.js';

const ASTRONOMICAL_UNIT_KM = 149_597_870.7;

/** IAU 2015 nominal solar luminance, in watts. */
export const SOLAR_LUMINOSITY_W = 3.828e26;

/**
 * Fraction of beam power that is *not* collimated.
 *
 * Bell-rim spill and thermal re-radiation. Without it an ideal beam seen from
 * the side is exactly invisible — correct for a laser, useless for a ship you
 * are supposed to be able to find.
 */
export const PLUME_ISOTROPIC_FRACTION = 0.02;

/**
 * Collimation exponent of the aft lobe.
 *
 * Half-power half-angle `acos(0.5^(1/64)) = 0.1469 rad = 8.42°`.
 */
export const PLUME_LOBE_EXPONENT = 64;

/** Beam length in ship lengths at full throttle (plan §3.6). */
export const PLUME_MAX_LENGTH_SHIP_LENGTHS = 4;

/** Throttle exponent of the beam length (plan §3.6). */
export const PLUME_LENGTH_THROTTLE_EXPONENT = 0.7;

/**
 * Radiant intensity of the plume toward one direction, in W/sr.
 *
 * ```
 * I(θ) = P · [ f/(4π) + (1 − f)·(n+1)·max(0, cos θ)^n / (2π) ]
 * ```
 *
 * Both terms are normalized over their own solid angles — `∫cos^n θ dΩ` is
 * `2π/(n+1)` over a hemisphere — so `∫ I dΩ = P` exactly. The pattern
 * redistributes the drive's power; it never invents any.
 *
 * @param cosExhaustAngle cosine of the angle between the exhaust direction (the
 * ship's aft axis) and the direction to the observer.
 */
export function plumeRadiantIntensityWPerSr(
  radiantPowerW: number,
  cosExhaustAngle: number,
): number {
  if (!Number.isFinite(radiantPowerW) || radiantPowerW <= 0) return 0;
  if (!Number.isFinite(cosExhaustAngle)) return 0;
  const clampedCosine = Math.max(0, Math.min(1, cosExhaustAngle));
  const isotropic = PLUME_ISOTROPIC_FRACTION / (4 * Math.PI);
  const lobe =
    ((1 - PLUME_ISOTROPIC_FRACTION) *
      (PLUME_LOBE_EXPONENT + 1) *
      Math.pow(clampedCosine, PLUME_LOBE_EXPONENT)) /
    (2 * Math.PI);
  return radiantPowerW * (isotropic + lobe);
}

/**
 * Apparent magnitude of the plume alone, against the renderer's solar zero point.
 *
 * The Sun's irradiance at 1 AU is `L☉/(4π·(1 AU)²)`, and `SUN_MAGNITUDE_AT_ONE_AU`
 * is what the whole renderer already calls that, so
 *
 * ```
 * m = −26.74 − 2.5·log10( I(θ)/d² · 4π·(1 AU)² / L☉ )
 * ```
 *
 * Returns `Number.POSITIVE_INFINITY` for a dark drive: infinitely faint, which
 * `addMagnitudes` treats as zero flux without a special case.
 */
export function plumeApparentMagnitude(
  radiantPowerW: number,
  cosExhaustAngle: number,
  distanceKm: number,
): number {
  const intensity = plumeRadiantIntensityWPerSr(radiantPowerW, cosExhaustAngle);
  if (intensity <= 0) return Number.POSITIVE_INFINITY;
  if (!Number.isFinite(distanceKm) || distanceKm <= 0) return Number.NEGATIVE_INFINITY;
  const distanceM = distanceKm * 1_000;
  const astronomicalUnitM = ASTRONOMICAL_UNIT_KM * 1_000;
  const irradianceRatio =
    ((intensity / (distanceM * distanceM)) *
      (4 * Math.PI * astronomicalUnitM * astronomicalUnitM)) /
    SOLAR_LUMINOSITY_W;
  if (irradianceRatio <= 0) return Number.POSITIVE_INFINITY;
  return SUN_MAGNITUDE_AT_ONE_AU - 2.5 * Math.log10(irradianceRatio);
}

/**
 * Combines two apparent magnitudes by adding their fluxes.
 *
 * Magnitudes are logarithmic, so the reflected hull and the plume cannot simply
 * be added or minimised: `m = −2.5·log10(10^(−0.4·m₁) + 10^(−0.4·m₂))`.
 */
export function addMagnitudes(first: number, second: number): number {
  if (Number.isNaN(first) || Number.isNaN(second)) return Number.NaN;
  if (first === Number.NEGATIVE_INFINITY || second === Number.NEGATIVE_INFINITY) {
    return Number.NEGATIVE_INFINITY;
  }
  const firstFlux = Number.isFinite(first) ? Math.pow(10, -0.4 * first) : 0;
  const secondFlux = Number.isFinite(second) ? Math.pow(10, -0.4 * second) : 0;
  const totalFlux = firstFlux + secondFlux;
  if (totalFlux <= 0) return Number.POSITIVE_INFINITY;
  return -2.5 * Math.log10(totalFlux);
}

/**
 * Beam length in ship lengths: `4 · throttle^0.7` (plan §3.6).
 *
 * The exponent is what makes a quarter-throttle burn look like more than a
 * quarter of a beam, which is how a real exhaust reads.
 */
export function beamLengthShipLengths(throttle: number): number {
  if (!Number.isFinite(throttle) || throttle <= 0) return 0;
  const clamped = Math.min(1, throttle);
  return PLUME_MAX_LENGTH_SHIP_LENGTHS * Math.pow(clamped, PLUME_LENGTH_THROTTLE_EXPONENT);
}

/**
 * Emissive brightness multiplier of the beam and glow, from throttle.
 *
 * Deliberately not the same curve as the length: a low throttle should look
 * *dimmer as well as shorter*, and `throttle^0.5` keeps the low end visible
 * without letting a 5 % burn read as a full one.
 */
export function beamIntensity(throttle: number): number {
  if (!Number.isFinite(throttle) || throttle <= 0) return 0;
  return Math.sqrt(Math.min(1, throttle));
}
