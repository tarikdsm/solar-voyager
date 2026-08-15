/**
 * Blend primitives shared by every animated camera move.
 *
 * `OrbitCameraController` established the pair the game uses for focus
 * transfers — a smootherstep position blend and a logarithmic distance
 * interpolation — inline. `CameraDirector` (T0110) needs exactly the same two
 * curves to cross-fade between camera modes, so they live here and both callers
 * import them rather than keeping two copies that can drift.
 *
 * Everything in this module is pure, float64 and allocation-free: the vector and
 * quaternion helpers write into caller-owned output arrays.
 */

/** C² ease used for every camera position blend (Perlin's smootherstep). */
export function smootherstep(value: number): number {
  return value * value * value * (value * (value * 6 - 15) + 10);
}

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

/**
 * Interpolates a distance in log space.
 *
 * Camera distances span six orders of magnitude between a 157 m chase arm and a
 * 210,000 km observatory framing of Jupiter. A linear blend of those two spends
 * almost the whole transition indistinguishable from the far end; the log blend
 * makes the *ratio* move at a constant rate, which is what reads as a smooth
 * pull-out and push-in.
 */
export function interpolateLogarithmic(startKm: number, endKm: number, blend: number): number {
  if (!Number.isFinite(startKm) || startKm <= 0 || !Number.isFinite(endKm) || endKm <= 0) {
    throw new RangeError('Logarithmic interpolation requires positive finite distances.');
  }
  if (!Number.isFinite(blend)) throw new RangeError('Interpolation blend must be finite.');
  return Math.exp(Math.log(startKm) + (Math.log(endKm) - Math.log(startKm)) * blend);
}

/** Below this dot-product separation a unit slerp degenerates; lerp instead. */
const UNIT_SLERP_PARALLEL_EPSILON = 1e-6;

/**
 * Spherically interpolates two unit directions into `out` (3 components).
 *
 * Falls back to a normalized lerp when the inputs are within
 * {@link UNIT_SLERP_PARALLEL_EPSILON} of parallel (where `sin(theta)` underflows)
 * and, for antipodal inputs, to the start direction: there is no shortest arc
 * between opposite directions, and picking an arbitrary perpendicular would make
 * the blend depend on floating-point noise instead of on the inputs.
 */
export function slerpUnitDirectionInto(
  out: Float64Array,
  startX: number,
  startY: number,
  startZ: number,
  endX: number,
  endY: number,
  endZ: number,
  blend: number,
): Float64Array {
  const dot = clamp(startX * endX + startY * endY + startZ * endZ, -1, 1);
  if (dot > 1 - UNIT_SLERP_PARALLEL_EPSILON || dot < -1 + UNIT_SLERP_PARALLEL_EPSILON) {
    const startWeight = dot > 0 ? 1 - blend : 1;
    const endWeight = dot > 0 ? blend : 0;
    const x = startX * startWeight + endX * endWeight;
    const y = startY * startWeight + endY * endWeight;
    const z = startZ * startWeight + endZ * endWeight;
    const length = Math.hypot(x, y, z);
    if (length === 0) {
      out[0] = startX;
      out[1] = startY;
      out[2] = startZ;
      return out;
    }
    out[0] = x / length;
    out[1] = y / length;
    out[2] = z / length;
    return out;
  }
  const theta = Math.acos(dot);
  const sinTheta = Math.sin(theta);
  const startWeight = Math.sin((1 - blend) * theta) / sinTheta;
  const endWeight = Math.sin(blend * theta) / sinTheta;
  out[0] = startX * startWeight + endX * endWeight;
  out[1] = startY * startWeight + endY * endWeight;
  out[2] = startZ * startWeight + endZ * endWeight;
  return out;
}

/**
 * Shortest-arc quaternion slerp into `out` (4 components, xyzw).
 *
 * Sign-corrects the target so the blend always takes the short way round, and
 * degenerates to a normalized lerp for nearly-equal rotations — which is the
 * common case for a per-frame attitude lag, where `blend` is small and the two
 * rotations are a frame apart.
 */
export function slerpQuaternionInto(
  out: Float64Array,
  start: Float64Array,
  end: Float64Array,
  blend: number,
): Float64Array {
  const startX = start[0] as number;
  const startY = start[1] as number;
  const startZ = start[2] as number;
  const startW = start[3] as number;
  let endX = end[0] as number;
  let endY = end[1] as number;
  let endZ = end[2] as number;
  let endW = end[3] as number;
  let dot = startX * endX + startY * endY + startZ * endZ + startW * endW;
  if (dot < 0) {
    endX = -endX;
    endY = -endY;
    endZ = -endZ;
    endW = -endW;
    dot = -dot;
  }
  let startWeight: number;
  let endWeight: number;
  if (dot > 1 - UNIT_SLERP_PARALLEL_EPSILON) {
    startWeight = 1 - blend;
    endWeight = blend;
  } else {
    const theta = Math.acos(clamp(dot, -1, 1));
    const sinTheta = Math.sin(theta);
    startWeight = Math.sin((1 - blend) * theta) / sinTheta;
    endWeight = Math.sin(blend * theta) / sinTheta;
  }
  const x = startX * startWeight + endX * endWeight;
  const y = startY * startWeight + endY * endWeight;
  const z = startZ * startWeight + endZ * endWeight;
  const w = startW * startWeight + endW * endWeight;
  const length = Math.hypot(x, y, z, w);
  if (!Number.isFinite(length) || length === 0) {
    out[0] = startX;
    out[1] = startY;
    out[2] = startZ;
    out[3] = startW;
    return out;
  }
  out[0] = x / length;
  out[1] = y / length;
  out[2] = z / length;
  out[3] = w / length;
  return out;
}

/**
 * Fraction of the remaining error a first-order lag removes in `dtSec`.
 *
 * `1 - exp(-dt/tau)`, written once so every smoothed camera quantity uses the
 * same definition of "time constant" and a reviewer only has to check it here.
 */
export function firstOrderLagBlend(dtSec: number, timeConstantSec: number): number {
  if (!Number.isFinite(dtSec) || dtSec < 0) {
    throw new RangeError('Lag delta must be finite and nonnegative.');
  }
  if (!Number.isFinite(timeConstantSec) || timeConstantSec <= 0) {
    throw new RangeError('Lag time constant must be finite and positive.');
  }
  return 1 - Math.exp(-dtSec / timeConstantSec);
}
