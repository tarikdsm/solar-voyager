// v2 plan §5 T0116 — the arrival insertion maths, target-relative and pure.
//
// Deliberately *not* read from `SimSnapshot.osculatingElements`: those are
// measured against `dominantBodyIndex`, a hysteretic SOI heuristic that is
// usually but not necessarily the body the player picked. Insertion steers on
// the target the player picked, from `mu` in the compiled catalog and the
// target-relative state in the snapshot's body arrays.

/** Below this the direction is treated as degenerate and the fallback basis is used. */
const DEGENERATE_MAGNITUDE = 1e-12;

/** Circular orbit speed at radius `r` about `mu`; physics-spec §2 two-body. */
export function circularSpeedKmS(muKm3S2: number, radiusKm: number): number {
  if (!(muKm3S2 > 0) || !(radiusKm > 0)) return Number.NaN;
  return Math.sqrt(muKm3S2 / radiusKm);
}

/**
 * Magnitude of the osculating eccentricity vector
 * `e = ((v² − μ/r) r − (r·v) v)/μ` for a target-relative state.
 */
export function osculatingEccentricity(
  relativePositionKm: Float64Array,
  relativeVelocityKmS: Float64Array,
  muKm3S2: number,
): number {
  const rx = relativePositionKm[0] as number;
  const ry = relativePositionKm[1] as number;
  const rz = relativePositionKm[2] as number;
  const vx = relativeVelocityKmS[0] as number;
  const vy = relativeVelocityKmS[1] as number;
  const vz = relativeVelocityKmS[2] as number;
  const radiusKm = Math.hypot(rx, ry, rz);
  if (!(muKm3S2 > 0) || !(radiusKm > 0)) return Number.NaN;
  const speedSquared = vx * vx + vy * vy + vz * vz;
  const radialTerm = speedSquared - muKm3S2 / radiusKm;
  const radialVelocityProduct = rx * vx + ry * vy + rz * vz;
  const ex = (radialTerm * rx - radialVelocityProduct * vx) / muKm3S2;
  const ey = (radialTerm * ry - radialVelocityProduct * vy) / muKm3S2;
  const ez = (radialTerm * rz - radialVelocityProduct * vz) / muKm3S2;
  return Math.hypot(ex, ey, ez);
}

/**
 * Writes the unit tangent of the *chosen* insertion plane at `r`.
 *
 * `t̂ = unit(ẑ × r̂)` with the ecliptic pole `ẑ`, which yields a prograde,
 * near-equatorial circular orbit that is deterministic and independent of the
 * direction the ship happened to arrive from. Degenerates only over the poles,
 * where `x̂` takes over.
 */
export function writeEclipticTangentInto(
  outputDirection: Float64Array,
  relativePositionKm: Float64Array,
): Float64Array {
  const rx = relativePositionKm[0] as number;
  const ry = relativePositionKm[1] as number;
  const rz = relativePositionKm[2] as number;
  // z_hat x r = (-ry, rx, 0)
  let tx = -ry;
  let ty = rx;
  let tz = 0;
  if (Math.hypot(tx, ty, tz) <= DEGENERATE_MAGNITUDE * Math.hypot(rx, ry, rz)) {
    // x_hat x r = (0, -rz, ry)
    tx = 0;
    ty = -rz;
    tz = ry;
  }
  const magnitude = Math.hypot(tx, ty, tz);
  outputDirection[0] = tx / magnitude;
  outputDirection[1] = ty / magnitude;
  outputDirection[2] = tz / magnitude;
  return outputDirection;
}

/**
 * Writes the unit tangent of the plane the ship is *actually* moving in:
 * `t̂ = unit((r̂ × v̂) × r̂)`, i.e. the component of the velocity perpendicular to
 * the radius. This is the trim burn's basis — it corrects the orbit that burn 1
 * produced without changing the plane burn 1 chose.
 *
 * Falls back to {@link writeEclipticTangentInto} for radial or vanishing motion,
 * where the angular momentum vector carries no direction.
 */
export function writeOsculatingTangentInto(
  outputDirection: Float64Array,
  relativePositionKm: Float64Array,
  relativeVelocityKmS: Float64Array,
): Float64Array {
  const rx = relativePositionKm[0] as number;
  const ry = relativePositionKm[1] as number;
  const rz = relativePositionKm[2] as number;
  const vx = relativeVelocityKmS[0] as number;
  const vy = relativeVelocityKmS[1] as number;
  const vz = relativeVelocityKmS[2] as number;
  const hx = ry * vz - rz * vy;
  const hy = rz * vx - rx * vz;
  const hz = rx * vy - ry * vx;
  const angularMomentum = Math.hypot(hx, hy, hz);
  const radiusKm = Math.hypot(rx, ry, rz);
  const speedKmS = Math.hypot(vx, vy, vz);
  if (!(angularMomentum > DEGENERATE_MAGNITUDE * radiusKm * Math.max(speedKmS, 1e-12))) {
    return writeEclipticTangentInto(outputDirection, relativePositionKm);
  }
  const tx = hy * rz - hz * ry;
  const ty = hz * rx - hx * rz;
  const tz = hx * ry - hy * rx;
  const magnitude = Math.hypot(tx, ty, tz);
  outputDirection[0] = tx / magnitude;
  outputDirection[1] = ty / magnitude;
  outputDirection[2] = tz / magnitude;
  return outputDirection;
}
