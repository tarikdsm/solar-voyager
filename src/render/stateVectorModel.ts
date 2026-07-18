import { SPEED_OF_LIGHT_KM_S } from '../core/constants.js';

const SHIP_MASS_KG = 10_000;
const NEAR_LIGHT_GAMMA = 1 / Math.sqrt(1 - 0.99 * 0.99);
const SI_PREFIXES = Object.freeze(['n', 'µ', 'm', '', 'k', 'M', 'G', 'T', 'P', 'E', 'Z', 'Y']);
const SI_NUMBER_FORMAT = new Intl.NumberFormat('en-US', {
  maximumSignificantDigits: 3,
  useGrouping: false,
});

export const STATE_VECTOR_COMPONENT_COUNT = 12;

export const StateVectorKind = Object.freeze({
  VELOCITY: 0,
  ACCELERATION: 1,
  MOMENTUM: 2,
  ANGULAR_MOMENTUM: 3,
} as const);

export type StateVectorKind = (typeof StateVectorKind)[keyof typeof StateVectorKind];

export interface StateVectorScale {
  readonly minMagnitude: number;
  readonly maxMagnitude: number;
  readonly minLength: number;
  readonly maxLength: number;
}

/** Per-dimension log domains used only for display geometry. Physical labels stay unscaled. */
export const STATE_VECTOR_SCALE: readonly [
  StateVectorScale,
  StateVectorScale,
  StateVectorScale,
  StateVectorScale,
] = Object.freeze([
  Object.freeze({
    minMagnitude: 30,
    maxMagnitude: 0.99 * SPEED_OF_LIGHT_KM_S,
    minLength: 0.35,
    maxLength: 0.92,
  }),
  Object.freeze({
    minMagnitude: 1e-9,
    maxMagnitude: 0.009_806_65,
    minLength: 0.25,
    maxLength: 0.82,
  }),
  Object.freeze({
    minMagnitude: SHIP_MASS_KG * 30,
    maxMagnitude: SHIP_MASS_KG * NEAR_LIGHT_GAMMA * 0.99 * SPEED_OF_LIGHT_KM_S,
    minLength: 0.32,
    maxLength: 0.88,
  }),
  Object.freeze({
    minMagnitude: 1e12,
    maxMagnitude: 1e22,
    minLength: 0.3,
    maxLength: 0.86,
  }),
]);

/** Maps a positive magnitude into one bounded, monotonic logarithmic display length. */
export function logarithmicVectorLength(magnitude: number, scale: StateVectorScale): number {
  if (!Number.isFinite(magnitude) || magnitude <= 0) return 0;
  if (magnitude <= scale.minMagnitude) return scale.minLength;
  if (magnitude >= scale.maxMagnitude) return scale.maxLength;
  const normalized =
    Math.log10(magnitude / scale.minMagnitude) /
    Math.log10(scale.maxMagnitude / scale.minMagnitude);
  return scale.minLength + normalized * (scale.maxLength - scale.minLength);
}

function writeEndpointInto(
  output: Float32Array,
  outputOffset: number,
  vector: Float64Array,
  scale: StateVectorScale,
): boolean {
  const x = vector[0] as number;
  const y = vector[1] as number;
  const z = vector[2] as number;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
    output[outputOffset] = 0;
    output[outputOffset + 1] = 0;
    output[outputOffset + 2] = 0;
    return false;
  }
  const magnitude = Math.hypot(x, y, z);
  const length = logarithmicVectorLength(magnitude, scale);
  if (length === 0) {
    output[outputOffset] = 0;
    output[outputOffset + 1] = 0;
    output[outputOffset + 2] = 0;
    return false;
  }
  const scaleFactor = length / magnitude;
  output[outputOffset] = x * scaleFactor;
  output[outputOffset + 1] = y * scaleFactor;
  output[outputOffset + 2] = z * scaleFactor;
  return true;
}

/** Writes four scaled endpoints without allocating or changing their physical direction. */
export function writeStateVectorEndpointsInto(
  output: Float32Array,
  velocityKmS: Float64Array,
  accelerationKmS2: Float64Array,
  momentumKgKmS: Float64Array,
  angularMomentumKgKm2S: Float64Array,
): number {
  if (output.length < STATE_VECTOR_COMPONENT_COUNT) {
    throw new RangeError(`State-vector output requires ${STATE_VECTOR_COMPONENT_COUNT} components`);
  }
  if (
    velocityKmS.length < 3 ||
    accelerationKmS2.length < 3 ||
    momentumKgKmS.length < 3 ||
    angularMomentumKgKm2S.length < 3
  ) {
    throw new RangeError('Each state vector requires three components');
  }

  let visibleMask = 0;
  if (writeEndpointInto(output, 0, velocityKmS, STATE_VECTOR_SCALE[0] as StateVectorScale)) {
    visibleMask |= 1 << StateVectorKind.VELOCITY;
  }
  if (writeEndpointInto(output, 3, accelerationKmS2, STATE_VECTOR_SCALE[1] as StateVectorScale)) {
    visibleMask |= 1 << StateVectorKind.ACCELERATION;
  }
  if (writeEndpointInto(output, 6, momentumKgKmS, STATE_VECTOR_SCALE[2] as StateVectorScale)) {
    visibleMask |= 1 << StateVectorKind.MOMENTUM;
  }
  if (
    writeEndpointInto(output, 9, angularMomentumKgKm2S, STATE_VECTOR_SCALE[3] as StateVectorScale)
  ) {
    visibleMask |= 1 << StateVectorKind.ANGULAR_MOMENTUM;
  }
  return visibleMask;
}

function formatSi(baseValue: number, unit: string): string {
  if (!Number.isFinite(baseValue) || baseValue < 0) return '—';
  if (baseValue === 0) return `0 ${unit}`;
  const absoluteValue = Math.abs(baseValue);
  let exponent = Math.floor(Math.log10(absoluteValue) / 3);
  if (exponent < -3) exponent = -3;
  if (exponent > 8) exponent = 8;
  let scaled = baseValue / 1_000 ** exponent;
  if (Math.abs(scaled) >= 999.5 && exponent < 8) {
    exponent += 1;
    scaled /= 1_000;
  }
  return `${SI_NUMBER_FORMAT.format(scaled)} ${SI_PREFIXES[exponent + 3]}${unit}`;
}

/** Formats one snapshot magnitude in coherent SI units with three significant digits. */
export function formatStateVectorMagnitude(kind: StateVectorKind, magnitude: number): string {
  switch (kind) {
    case StateVectorKind.VELOCITY:
      return formatSi(magnitude * 1_000, 'm/s');
    case StateVectorKind.ACCELERATION:
      return formatSi(magnitude * 1_000, 'm/s²');
    case StateVectorKind.MOMENTUM:
      return formatSi(magnitude * 1_000, 'N·s');
    case StateVectorKind.ANGULAR_MOMENTUM:
      return formatSi(magnitude * 1_000_000, 'kg·m²/s');
  }
}
