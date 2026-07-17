import type { OsculatingElementsSnapshot } from '../sim/simulationSnapshot.js';

export const MAX_OSCULATING_CONIC_SEGMENTS = 256;
const MINIMUM_OUTPUT_COMPONENTS = (MAX_OSCULATING_CONIC_SEGMENTS + 1) * 3;
const FULL_TURN_RAD = 2 * Math.PI;
const HYPERBOLA_RADIUS_MULTIPLIER = 200;
const HYPERBOLA_AXIS_MULTIPLIER = 20;
const ASYMPTOTE_MARGIN_RAD = 1e-4;

function elementsUseRenderableBranch(elements: Readonly<OsculatingElementsSnapshot>): boolean {
  const semiMajorAxisKm = elements.semiMajorAxisKm;
  const eccentricity = elements.eccentricity;
  return (
    elements.valid &&
    Number.isFinite(semiMajorAxisKm) &&
    Number.isFinite(eccentricity) &&
    Number.isFinite(elements.inclinationRad) &&
    Number.isFinite(elements.longitudeAscendingNodeRad) &&
    Number.isFinite(elements.argumentPeriapsisRad) &&
    Number.isFinite(elements.periapsisRadiusKm) &&
    elements.periapsisRadiusKm > 0 &&
    ((semiMajorAxisKm > 0 && eccentricity >= 0 && eccentricity < 1) ||
      (semiMajorAxisKm < 0 && eccentricity > 1))
  );
}

/** Returns the rendering-spec §7 segment rung for one valid conic. */
export function requiredOsculatingSegmentCount(
  elements: Readonly<OsculatingElementsSnapshot>,
): number {
  if (!elementsUseRenderableBranch(elements)) return 0;
  if (elements.eccentricity < 0.25) return 64;
  if (elements.eccentricity < 0.75) return 128;
  return MAX_OSCULATING_CONIC_SEGMENTS;
}

/** Writes physics-spec.md §6 body-relative conic points without allocating. */
export function writeOsculatingConicPointsInto(
  outputKm: Float64Array,
  elements: Readonly<OsculatingElementsSnapshot>,
): number {
  if (outputKm.length < MINIMUM_OUTPUT_COMPONENTS) {
    throw new RangeError(
      `osculating conic output requires ${MINIMUM_OUTPUT_COMPONENTS} components`,
    );
  }
  const segmentCount = requiredOsculatingSegmentCount(elements);
  if (segmentCount === 0) return 0;

  const semiMajorAxisKm = elements.semiMajorAxisKm;
  const eccentricity = elements.eccentricity;
  const semilatusRectumKm = semiMajorAxisKm * (1 - eccentricity * eccentricity);
  if (!Number.isFinite(semilatusRectumKm) || semilatusRectumKm <= 0) return 0;

  let startTrueAnomalyRad = -Math.PI;
  let anomalySpanRad = FULL_TURN_RAD;
  if (eccentricity > 1) {
    const asymptoteRad = Math.acos(-1 / eccentricity);
    const renderRadiusKm = Math.max(
      elements.periapsisRadiusKm * HYPERBOLA_RADIUS_MULTIPLIER,
      Math.abs(semiMajorAxisKm) * HYPERBOLA_AXIS_MULTIPLIER,
    );
    const limitedCosine = Math.max(
      -1,
      Math.min(1, (semilatusRectumKm / renderRadiusKm - 1) / eccentricity),
    );
    const limitRad = Math.min(asymptoteRad - ASYMPTOTE_MARGIN_RAD, Math.acos(limitedCosine));
    if (!Number.isFinite(limitRad) || limitRad <= 0) return 0;
    startTrueAnomalyRad = -limitRad;
    anomalySpanRad = 2 * limitRad;
  }

  const cosineNode = Math.cos(elements.longitudeAscendingNodeRad);
  const sineNode = Math.sin(elements.longitudeAscendingNodeRad);
  const cosineInclination = Math.cos(elements.inclinationRad);
  const sineInclination = Math.sin(elements.inclinationRad);
  const cosinePeriapsis = Math.cos(elements.argumentPeriapsisRad);
  const sinePeriapsis = Math.sin(elements.argumentPeriapsisRad);
  const rotation11 = cosineNode * cosinePeriapsis - sineNode * sinePeriapsis * cosineInclination;
  const rotation12 = -cosineNode * sinePeriapsis - sineNode * cosinePeriapsis * cosineInclination;
  const rotation21 = sineNode * cosinePeriapsis + cosineNode * sinePeriapsis * cosineInclination;
  const rotation22 = -sineNode * sinePeriapsis + cosineNode * cosinePeriapsis * cosineInclination;
  const rotation31 = sinePeriapsis * sineInclination;
  const rotation32 = cosinePeriapsis * sineInclination;
  const pointCount = segmentCount + 1;

  for (let pointIndex = 0; pointIndex < pointCount; pointIndex += 1) {
    const trueAnomalyRad = startTrueAnomalyRad + anomalySpanRad * (pointIndex / segmentCount);
    const cosineAnomaly = Math.cos(trueAnomalyRad);
    const sineAnomaly = Math.sin(trueAnomalyRad);
    const radiusKm = semilatusRectumKm / (1 + eccentricity * cosineAnomaly);
    const perifocalXKm = radiusKm * cosineAnomaly;
    const perifocalYKm = radiusKm * sineAnomaly;
    const offset = pointIndex * 3;
    outputKm[offset] = rotation11 * perifocalXKm + rotation12 * perifocalYKm;
    outputKm[offset + 1] = rotation21 * perifocalXKm + rotation22 * perifocalYKm;
    outputKm[offset + 2] = rotation31 * perifocalXKm + rotation32 * perifocalYKm;
  }
  return pointCount;
}
