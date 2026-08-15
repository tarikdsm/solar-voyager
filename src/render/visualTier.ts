import type { ReadonlyVec3 } from '../core/vec3.js';

export type VisualTier = 1 | 2 | 3;

const ASTRONOMICAL_UNIT_KM = 149_597_870.7;
const SUN_MAGNITUDE_AT_ONE_AU = -26.74;
const POINT_TO_SPHERE_PX = 1.8;
const SPHERE_TO_POINT_PX = 1.2;
const SPHERE_TO_MODEL_PX = 240;
const MODEL_TO_SPHERE_PX = 160;
const MIN_BRIGHTNESS_RATIO = 1e-300;
const MAX_BRIGHTNESS_RATIO = 1e300;
const MAX_POINT_INTENSITY = 8;
const POINT_INTENSITY_REFERENCE_MAGNITUDE = 6;

/** Shared cross-fade duration for every point/sphere/model tier transition. */
export const TIER_FADE_DURATION_MS = 250;

function assertFiniteNonnegative(label: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be a finite nonnegative number.`);
  }
}

function distance3(x: number, y: number, z: number): number {
  return Math.sqrt(x * x + y * y + z * z);
}

function packedOffset(index: number, positionsKm: Float64Array): number {
  if (!Number.isInteger(index) || index < 0 || index * 3 + 2 >= positionsKm.length) {
    throw new RangeError('Body index must address one packed xyz position.');
  }
  return index * 3;
}

function boundedBrightness(value: number): number {
  if (!Number.isFinite(value)) {
    return value > 0 ? MAX_BRIGHTNESS_RATIO : MIN_BRIGHTNESS_RATIO;
  }
  return Math.min(MAX_BRIGHTNESS_RATIO, Math.max(MIN_BRIGHTNESS_RATIO, value));
}

/** Returns the true angular diameter expressed in vertical viewport pixels. */
export function projectedDiameterPx(
  radiusKm: number,
  distanceKm: number,
  viewportHeightPx: number,
  verticalFovRad: number,
): number {
  assertFiniteNonnegative('radiusKm', radiusKm);
  assertFiniteNonnegative('distanceKm', distanceKm);
  if (!Number.isFinite(viewportHeightPx) || viewportHeightPx <= 0) {
    throw new RangeError('viewportHeightPx must be a finite positive number.');
  }
  if (!Number.isFinite(verticalFovRad) || verticalFovRad <= 0 || verticalFovRad >= Math.PI) {
    throw new RangeError('verticalFovRad must be finite and between zero and pi.');
  }

  const radiusDistanceRatio = distanceKm === 0 ? (radiusKm === 0 ? 0 : 1) : radiusKm / distanceKm;
  const angularDiameterRad = 2 * Math.asin(Math.min(1, radiusDistanceRatio));
  return (angularDiameterRad * viewportHeightPx) / verticalFovRad;
}

/**
 * Decides whether a visual resolves into geometry at all, with the twenty-percent
 * hysteresis band shared by every representation ladder in the renderer.
 *
 * This is the single point/geometry boundary: `selectVisualTier` routes its
 * tier-1 decisions through it, and visuals with only two representations (the
 * ship) consult it directly instead of growing a parallel ladder.
 */
export function selectResolvedRepresentation(resolved: boolean, diameterPx: number): boolean {
  assertFiniteNonnegative('diameterPx', diameterPx);
  return diameterPx >= (resolved ? SPHERE_TO_POINT_PX : POINT_TO_SPHERE_PX);
}

/** Selects a representation with twenty-percent hysteresis around both boundaries. */
export function selectVisualTier(
  current: VisualTier,
  diameterPx: number,
  modelThresholdScale = 1,
): VisualTier {
  if (current !== 1 && current !== 2 && current !== 3) {
    throw new RangeError('current visual tier must be 1, 2, or 3.');
  }
  assertFiniteNonnegative('diameterPx', diameterPx);
  if (!Number.isFinite(modelThresholdScale) || modelThresholdScale < 1) {
    throw new RangeError('model threshold scale must be finite and at least one.');
  }
  if (!selectResolvedRepresentation(current !== 1, diameterPx)) return 1;
  if (current === 3) return diameterPx < MODEL_TO_SPHERE_PX * modelThresholdScale ? 2 : 3;
  return diameterPx >= SPHERE_TO_MODEL_PX * modelThresholdScale ? 3 : 2;
}

/**
 * Converts an apparent magnitude into the additive point-cloud intensity scale.
 *
 * Shared by every point-cloud writer so the visual brightness of a body and of
 * the ship come from one curve: magnitude 6 (the naked-eye limit) renders at
 * unit intensity and the clamp keeps the brightest objects from washing the
 * additive buffer out.
 */
export function pointIntensityForMagnitude(magnitude: number): number {
  return Math.min(
    MAX_POINT_INTENSITY,
    Math.pow(10, -0.4 * (magnitude - POINT_INTENSITY_REFERENCE_MAGNITUDE)),
  );
}

/**
 * Computes solar or Lambertian reflected-light apparent magnitude directly
 * from packed heliocentric positions without allocating temporary vectors.
 */
export function apparentMagnitude(
  bodyIndex: number,
  sunIndex: number,
  meanRadiusKm: number,
  geometricAlbedo: number,
  positionsKm: Float64Array,
  cameraPositionKm: ReadonlyVec3,
): number {
  if (positionsKm.length % 3 !== 0) {
    throw new RangeError('positionsKm must contain packed xyz triples.');
  }
  const bodyOffset = packedOffset(bodyIndex, positionsKm);
  const sunOffset = packedOffset(sunIndex, positionsKm);
  if (!Number.isFinite(meanRadiusKm) || meanRadiusKm <= 0) {
    throw new RangeError('meanRadiusKm must be a finite positive number.');
  }
  assertFiniteNonnegative('geometricAlbedo', geometricAlbedo);
  if (
    !Number.isFinite(cameraPositionKm.x) ||
    !Number.isFinite(cameraPositionKm.y) ||
    !Number.isFinite(cameraPositionKm.z)
  ) {
    throw new RangeError('cameraPositionKm must contain finite coordinates.');
  }

  const bodyX = positionsKm[bodyOffset];
  const bodyY = positionsKm[bodyOffset + 1];
  const bodyZ = positionsKm[bodyOffset + 2];
  const sunX = positionsKm[sunOffset];
  const sunY = positionsKm[sunOffset + 1];
  const sunZ = positionsKm[sunOffset + 2];
  if (
    bodyX === undefined ||
    bodyY === undefined ||
    bodyZ === undefined ||
    sunX === undefined ||
    sunY === undefined ||
    sunZ === undefined ||
    !Number.isFinite(bodyX) ||
    !Number.isFinite(bodyY) ||
    !Number.isFinite(bodyZ) ||
    !Number.isFinite(sunX) ||
    !Number.isFinite(sunY) ||
    !Number.isFinite(sunZ)
  ) {
    throw new RangeError('positionsKm must contain finite coordinates.');
  }

  const observerSunX = cameraPositionKm.x - sunX;
  const observerSunY = cameraPositionKm.y - sunY;
  const observerSunZ = cameraPositionKm.z - sunZ;
  const observerSunKm = Math.max(
    bodyIndex === sunIndex ? meanRadiusKm : 1,
    distance3(observerSunX, observerSunY, observerSunZ),
  );
  const solarMagnitude =
    SUN_MAGNITUDE_AT_ONE_AU + 5 * Math.log10(observerSunKm / ASTRONOMICAL_UNIT_KM);
  if (bodyIndex === sunIndex) {
    return solarMagnitude;
  }

  const bodySunX = sunX - bodyX;
  const bodySunY = sunY - bodyY;
  const bodySunZ = sunZ - bodyZ;
  const bodyObserverX = cameraPositionKm.x - bodyX;
  const bodyObserverY = cameraPositionKm.y - bodyY;
  const bodyObserverZ = cameraPositionKm.z - bodyZ;
  const bodySunKm = Math.max(1, distance3(bodySunX, bodySunY, bodySunZ));
  const observerBodyRawKm = distance3(bodyObserverX, bodyObserverY, bodyObserverZ);
  const observerBodyKm = Math.max(meanRadiusKm, observerBodyRawKm);

  let cosPhase = 1;
  if (observerBodyRawKm > 0) {
    cosPhase =
      (bodySunX * bodyObserverX + bodySunY * bodyObserverY + bodySunZ * bodyObserverZ) /
      (bodySunKm * observerBodyRawKm);
    cosPhase = Math.max(-1, Math.min(1, cosPhase));
  }
  const phaseAngle = Math.acos(cosPhase);
  const lambertPhase = (Math.sin(phaseAngle) + (Math.PI - phaseAngle) * cosPhase) / Math.PI;
  const brightnessRatio = boundedBrightness(
    (geometricAlbedo * lambertPhase * meanRadiusKm * meanRadiusKm * observerSunKm * observerSunKm) /
      (bodySunKm * bodySunKm * observerBodyKm * observerBodyKm),
  );

  return solarMagnitude - 2.5 * Math.log10(brightnessRatio);
}
