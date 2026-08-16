// rendering-spec.md §5.2 / physics-spec.md §6.3 — zodiacal-light surface brightness.

import { AU_KM } from '../core/constants.js';

/**
 * sRGB reference white, IEC 61966-2-1 reference viewing environment.
 *
 * The renderer has no absolute photometric calibration, so "nits" only means
 * anything against a stated reference. One unit of linear display radiance is
 * this many cd/m^2, which is what turns the "at most 2 nits" budget into the
 * concrete cap {@link ZODIACAL_PEAK_DISPLAY_RADIANCE}.
 */
export const DISPLAY_REFERENCE_WHITE_NITS = 100;

/** The budgeted ceiling for the zodiacal gradient, in cd/m^2. */
export const ZODIACAL_MAX_NITS = 2;

/** Peak linear display radiance of the band: 2 nits against a 100-nit white. */
export const ZODIACAL_PEAK_DISPLAY_RADIANCE = ZODIACAL_MAX_NITS / DISPLAY_REFERENCE_WHITE_NITS;

/** Solar elongation at and below which the elongation term saturates (30 deg). */
export const ZODIACAL_PEAK_ELONGATION_RAD = Math.PI / 6;
/**
 * Inner working angle: 15 deg, below which the band is not drawn at all.
 *
 * Leinert et al. tabulate zodiacal brightness only for elongations above ~15
 * deg, because closer in the F-corona dominates and the Sun swamps the
 * measurement. Solar Voyager already renders that light — it is the procedural
 * Sun's corona — so continuing the band inward would double-count it and paint a
 * flat 2-nit disc across a 60 deg cone centred on the Sun. The term is tapered
 * smoothly to zero across this angle instead of being clamped to a plateau.
 */
export const ZODIACAL_INNER_WORKING_ANGLE_RAD = Math.PI / 12;
/** Falloff exponent of surface brightness with solar elongation. */
export const ZODIACAL_ELONGATION_EXPONENT = 1.3;
/** Amplitude of the anti-solar gegenschein bump, relative to the peak. */
export const ZODIACAL_GEGENSCHEIN_AMPLITUDE = 0.1;
/** Angular width of the gegenschein bump, in radians. */
export const ZODIACAL_GEGENSCHEIN_WIDTH_RAD = 0.35;
/** Fraction of the ecliptic brightness that survives at the ecliptic pole. */
export const ZODIACAL_POLAR_FLOOR = 0.385;
/** Exponent of the cosine-latitude term. */
export const ZODIACAL_LATITUDE_EXPONENT = 3.5;
/** Exponent of the heliocentric-distance falloff. */
export const ZODIACAL_HELIOCENTRIC_EXPONENT = 2.3;
/** Distance below which the falloff is clamped, in AU (inside Mercury). */
export const ZODIACAL_MINIMUM_DISTANCE_AU = 0.3;

/** Scattered sunlight is slightly redder than the Sun (Leinert et al. 1998 §8.3). */
export const ZODIACAL_COLOR = Object.freeze([1, 0.96, 0.88] as const);

/**
 * Zodiacal-light surface brightness in linear display units.
 *
 * An analytic fit, not a radiative-transfer solution. The shape reproduces the
 * three features that matter visually and are reported in Leinert et al. (1998),
 * "The 1997 reference of diffuse night sky brightness", A&AS 127, 1 (§8):
 * brightness rises steeply toward small solar elongation and saturates near the
 * inner working angle; it falls by roughly a factor 2.6 from the ecliptic to the
 * ecliptic pole; and a shallow gegenschein bump sits at the anti-solar point.
 * Inside {@link ZODIACAL_INNER_WORKING_ANGLE_RAD} the band tapers to nothing,
 * where the procedural Sun's corona takes over.
 * The absolute scale is a display budget, not a photometric measurement — the
 * real band is ~1e-3 nits and would be invisible under any tone curve.
 *
 * The GLSL in {@link ZODIACAL_LIGHT_GLSL} evaluates exactly this expression with
 * exactly these constants; keep the two in step.
 */
export function zodiacalLightDisplayRadiance(
  solarElongationRad: number,
  eclipticLatitudeRad: number,
  heliocentricDistanceKm: number,
): number {
  const elongation = Math.max(Math.abs(solarElongationRad), 1e-3);
  const elongationTerm = Math.min(
    1,
    (ZODIACAL_PEAK_ELONGATION_RAD / elongation) ** ZODIACAL_ELONGATION_EXPONENT,
  );
  const antiSolar = (Math.PI - elongation) / ZODIACAL_GEGENSCHEIN_WIDTH_RAD;
  const gegenschein = ZODIACAL_GEGENSCHEIN_AMPLITUDE * Math.exp(-antiSolar * antiSolar);
  const shape =
    Math.min(1, elongationTerm + gegenschein) *
    // Taper from the unclamped angle so a sightline straight at the Sun is exactly zero.
    innerWorkingAngleTaper(Math.abs(solarElongationRad));
  const latitude =
    ZODIACAL_POLAR_FLOOR +
    (1 - ZODIACAL_POLAR_FLOOR) *
      Math.abs(Math.cos(eclipticLatitudeRad)) ** ZODIACAL_LATITUDE_EXPONENT;
  const distanceAu = Math.max(heliocentricDistanceKm / AU_KM, ZODIACAL_MINIMUM_DISTANCE_AU);
  const distance = Math.min(1, (1 / distanceAu) ** ZODIACAL_HELIOCENTRIC_EXPONENT);
  return ZODIACAL_PEAK_DISPLAY_RADIANCE * shape * latitude * distance;
}

/** Smoothstep from 0 at the Sun to 1 at the inner working angle. */
function innerWorkingAngleTaper(elongationRad: number): number {
  const t = Math.min(1, Math.max(0, elongationRad / ZODIACAL_INNER_WORKING_ANGLE_RAD));
  return t * t * (3 - 2 * t);
}

function glslFloat(value: number): string {
  return Number.isInteger(value) ? `${String(value)}.0` : String(value);
}

/**
 * The fragment-stage half of the model above.
 *
 * `uZodiacalScale` folds the peak radiance, the heliocentric falloff and the
 * settings toggle into one CPU-side scalar so the shader never divides by an
 * astronomical unit and the toggle costs no branch.
 */
export const ZODIACAL_LIGHT_GLSL = /* glsl */ `
  uniform vec3 uSunDirection;
  uniform float uZodiacalScale;
  uniform vec3 uZodiacalColor;

  // rendering-spec.md section 5.2 — analytic zodiacal-light surface brightness.
  vec3 zodiacalLight(vec3 eclipticDirection) {
    if (uZodiacalScale <= 0.0) return vec3(0.0);
    float elongation = max(acos(clamp(dot(eclipticDirection, uSunDirection), -1.0, 1.0)), 1e-3);
    float elongationTerm =
      min(1.0, pow(${glslFloat(ZODIACAL_PEAK_ELONGATION_RAD)} / elongation, ${glslFloat(ZODIACAL_ELONGATION_EXPONENT)}));
    float antiSolar = (3.141592653589793 - elongation) / ${glslFloat(ZODIACAL_GEGENSCHEIN_WIDTH_RAD)};
    // Tapered to nothing inside the inner working angle; the procedural Sun's
    // corona owns the light there.
    float taper = smoothstep(0.0, ${glslFloat(ZODIACAL_INNER_WORKING_ANGLE_RAD)}, elongation);
    float shape =
      min(1.0, elongationTerm + ${glslFloat(ZODIACAL_GEGENSCHEIN_AMPLITUDE)} * exp(-antiSolar * antiSolar)) *
      taper;
    float cosineLatitude = sqrt(max(0.0, 1.0 - eclipticDirection.z * eclipticDirection.z));
    float latitude =
      ${glslFloat(ZODIACAL_POLAR_FLOOR)} +
      ${glslFloat(1 - ZODIACAL_POLAR_FLOOR)} * pow(cosineLatitude, ${glslFloat(ZODIACAL_LATITUDE_EXPONENT)});
    return uZodiacalColor * (uZodiacalScale * shape * latitude);
  }
`;

/**
 * The CPU-side scalar the shader multiplies by: peak radiance times the
 * heliocentric falloff, or zero when the band is switched off.
 */
export function zodiacalLightScale(enabled: boolean, heliocentricDistanceKm: number): number {
  if (!enabled) return 0;
  const distanceAu = Math.max(heliocentricDistanceKm / AU_KM, ZODIACAL_MINIMUM_DISTANCE_AU);
  const distance = Math.min(1, (1 / distanceAu) ** ZODIACAL_HELIOCENTRIC_EXPONENT);
  return ZODIACAL_PEAK_DISPLAY_RADIANCE * distance;
}
