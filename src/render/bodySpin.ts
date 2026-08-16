/**
 * Sidereal rotation and axial tilt for every catalogued body.
 *
 * This module is the **single owner** of the catalog's `axialTiltRad` geometry:
 * nothing else may turn an axial tilt into a transform, or the tilt lands twice
 * (rendering-spec §3.2). It publishes one quaternion per body into a packed
 * float64 attitude array, alongside the raw spin angle that sub-frames such as
 * the ring particle field need in order to opt *out* of the rotation.
 *
 * Frame (rendering-spec §3.2): the render frame is the physics frame —
 * heliocentric ecliptic J2000, `+Z` ecliptic north. Assets are glTF Y-up with
 * model-local `+Y` as the north pole, so
 *
 *   q_body(t) = R_x(pi/2 - axialTiltRad) . R_y(theta(t))
 *   theta(t)  = W0 + 2*pi * (t mod T) / T
 *
 * carries the model pole to `(0, sin tilt, cos tilt)` — tilted away from
 * ecliptic north toward ecliptic longitude 90 degrees — and spins the body
 * about it. `T` is the signed `siderealRotationPeriodSec`; a negative period is
 * retrograde about that declared pole (`data/bodies.schema.json`).
 *
 * The lean direction is exact for Earth (its equator's ascending node on the
 * ecliptic *is* the vernal equinox) and is a stated convention for every other
 * body, because the catalog carries no IAU pole `(alpha0, delta0)`. Likewise the
 * epoch phase `W0` is zero for every body but Earth: the catalog carries no
 * prime-meridian angle, so what ships is a phase-accurate rotation *rate* with
 * an arbitrary epoch phase. Design:
 * `docs/superpowers/specs/2026-08-16-body-rotation-design.md`.
 */

const TWO_PI = Math.PI * 2;
const HALF_PI = Math.PI / 2;

/**
 * Greenwich mean sidereal time at the J2026 TDB epoch (JD 2461041.5), radians.
 *
 * IAU-1982 at 0h UT1 with `T = (JD - 2451545.0) / 36525`:
 * `GMST = 24110.54841 + 8640184.812866 T + 0.093104 T^2 - 6.2e-6 T^3` seconds
 * `= 24158.606 s = 100.660859 deg`. Cross-checked against the USNO short form
 * `GMST_h = 18.697374558 + 24.06570982441908 (JD - 2451545.0)` to 2.6e-5 deg.
 *
 * With the frame above this is exactly Earth's prime-meridian angle, so the
 * anchor makes the rendered sub-solar point real near the epoch. It ignores
 * precession of the equinox (~0.33 deg accumulated since J2000), nutation and
 * UT1-TDB, so it is good to a few tenths of a degree and drifts ~0.014 deg/yr.
 */
export const EARTH_PRIME_MERIDIAN_EPOCH_RAD = 1.756_863_409_355;

/** Bodies with a defensible epoch phase. Everything else spins from zero. */
const PRIME_MERIDIAN_EPOCH_RAD = new Map<string, number>([
  ['earth', EARTH_PRIME_MERIDIAN_EPOCH_RAD],
]);

export interface BodySpinDefinition {
  readonly id: string;
  /** Signed: negative is retrograde about the declared pole. Never zero. */
  readonly siderealRotationPeriodSec: number;
  readonly axialTiltRad: number;
}

/** The anchored prime-meridian angle at epoch, or zero when uncalibrated. */
export function primeMeridianEpochRad(id: string): number {
  return PRIME_MERIDIAN_EPOCH_RAD.get(id) ?? 0;
}

function assertFinite(label: string, value: number): void {
  if (!Number.isFinite(value)) throw new RangeError(`${label} must be finite.`);
}

function assertTilt(axialTiltRad: number): void {
  if (!Number.isFinite(axialTiltRad) || axialTiltRad < 0 || axialTiltRad > TWO_PI) {
    throw new RangeError('Body axial tilt must be finite and within one turn.');
  }
}

function assertPeriod(siderealRotationPeriodSec: number): void {
  if (!Number.isFinite(siderealRotationPeriodSec) || siderealRotationPeriodSec === 0) {
    throw new RangeError('Sidereal rotation period must be finite and nonzero.');
  }
}

/**
 * Rotation angle about the declared pole at `simTimeSec`.
 *
 * The modulo runs before the scale so a multi-century session keeps full
 * precision in the angle, matching the bounded-modulo rule the gas-giant
 * animation already follows (rendering-spec §11).
 */
export function bodySpinAngleRad(
  simTimeSec: number,
  siderealRotationPeriodSec: number,
  primeMeridianRad = 0,
): number {
  assertFinite('Simulation time', simTimeSec);
  assertPeriod(siderealRotationPeriodSec);
  assertFinite('Prime-meridian angle', primeMeridianRad);
  return (
    primeMeridianRad +
    (TWO_PI * (simTimeSec % siderealRotationPeriodSec)) / siderealRotationPeriodSec
  );
}

/** Writes the body's north-pole direction in world (ecliptic J2000) coordinates. */
export function writeBodyPoleInto(out: Float64Array, offset: number, axialTiltRad: number): void {
  assertTilt(axialTiltRad);
  out[offset] = 0;
  out[offset + 1] = Math.sin(axialTiltRad);
  out[offset + 2] = Math.cos(axialTiltRad);
}

/**
 * Writes `q = R_x(pi/2 - tilt) . R_y(spin)` as xyzw.
 *
 * Both factors are axis-aligned, so the Hamilton product collapses to four
 * multiplies over the two half-angle sine/cosine pairs.
 */
export function writeBodyAttitudeInto(
  out: Float64Array,
  offset: number,
  axialTiltRad: number,
  spinAngleRad: number,
): void {
  assertTilt(axialTiltRad);
  assertFinite('Spin angle', spinAngleRad);
  const frameHalf = (HALF_PI - axialTiltRad) * 0.5;
  const frameX = Math.sin(frameHalf);
  const frameW = Math.cos(frameHalf);
  const spinHalf = spinAngleRad * 0.5;
  const spinY = Math.sin(spinHalf);
  const spinW = Math.cos(spinHalf);
  out[offset] = frameX * spinW;
  out[offset + 1] = frameW * spinY;
  out[offset + 2] = frameX * spinY;
  out[offset + 3] = frameW * spinW;
}

/**
 * Rotates a world vector into the body's non-spinning equatorial frame
 * (pole `+Y`, `+X` on the equator at the J2000 vernal equinox).
 */
export function writeEquatorFrameVectorInto(
  out: Float64Array,
  worldX: number,
  worldY: number,
  worldZ: number,
  axialTiltRad: number,
): void {
  assertTilt(axialTiltRad);
  const sine = Math.sin(axialTiltRad);
  const cosine = Math.cos(axialTiltRad);
  out[0] = worldX;
  out[1] = worldY * sine + worldZ * cosine;
  out[2] = -worldY * cosine + worldZ * sine;
}

/** Rotates a world vector into the spinning body-fixed frame (inverse attitude). */
export function writeBodyFrameVectorInto(
  out: Float64Array,
  worldX: number,
  worldY: number,
  worldZ: number,
  axialTiltRad: number,
  spinAngleRad: number,
): void {
  assertFinite('Spin angle', spinAngleRad);
  writeEquatorFrameVectorInto(out, worldX, worldY, worldZ, axialTiltRad);
  const equatorialX = out[0] as number;
  const equatorialZ = out[2] as number;
  const sine = Math.sin(spinAngleRad);
  const cosine = Math.cos(spinAngleRad);
  out[0] = equatorialX * cosine - equatorialZ * sine;
  out[2] = equatorialX * sine + equatorialZ * cosine;
}

/**
 * The packed attitude path: one preallocated quaternion per catalog body,
 * rewritten in place once per frame from simulation time.
 */
export class BodySpin {
  readonly count: number;
  /** `count` xyzw quaternions, world attitude of each body. */
  readonly attitudesXyzw: Float64Array;
  /** `count` rotation angles about each declared pole, radians. */
  readonly spinAnglesRad: Float64Array;

  private readonly periodsSec: Float64Array;
  private readonly primeMeridiansRad: Float64Array;
  private readonly frameHalfSines: Float64Array;
  private readonly frameHalfCosines: Float64Array;

  constructor(definitions: readonly BodySpinDefinition[]) {
    if (definitions.length === 0) {
      throw new RangeError('Body spin requires at least one body definition.');
    }
    const count = definitions.length;
    this.count = count;
    this.attitudesXyzw = new Float64Array(count * 4);
    this.spinAnglesRad = new Float64Array(count);
    this.periodsSec = new Float64Array(count);
    this.primeMeridiansRad = new Float64Array(count);
    this.frameHalfSines = new Float64Array(count);
    this.frameHalfCosines = new Float64Array(count);

    for (let index = 0; index < count; index += 1) {
      const definition = definitions[index];
      if (definition === undefined) throw new Error('Body spin definitions are sparse.');
      assertPeriod(definition.siderealRotationPeriodSec);
      assertTilt(definition.axialTiltRad);
      this.periodsSec[index] = definition.siderealRotationPeriodSec;
      this.primeMeridiansRad[index] = primeMeridianEpochRad(definition.id);
      // The tilt never changes, so the frame half-angle terms are setup-time work.
      const frameHalf = (HALF_PI - definition.axialTiltRad) * 0.5;
      this.frameHalfSines[index] = Math.sin(frameHalf);
      this.frameHalfCosines[index] = Math.cos(frameHalf);
    }
    this.update(0);
  }

  /** Rewrites every attitude for one simulation time. Allocation-free. */
  update(simTimeSec: number): void {
    assertFinite('Simulation time', simTimeSec);
    for (let index = 0; index < this.count; index += 1) {
      const periodSec = this.periodsSec[index] as number;
      const spinAngleRad =
        (this.primeMeridiansRad[index] as number) + (TWO_PI * (simTimeSec % periodSec)) / periodSec;
      this.spinAnglesRad[index] = spinAngleRad;
      const spinHalf = spinAngleRad * 0.5;
      const spinY = Math.sin(spinHalf);
      const spinW = Math.cos(spinHalf);
      const frameX = this.frameHalfSines[index] as number;
      const frameW = this.frameHalfCosines[index] as number;
      const offset = index * 4;
      this.attitudesXyzw[offset] = frameX * spinW;
      this.attitudesXyzw[offset + 1] = frameW * spinY;
      this.attitudesXyzw[offset + 2] = frameX * spinY;
      this.attitudesXyzw[offset + 3] = frameW * spinW;
    }
  }

  spinAngleRadAt(index: number): number {
    if (!Number.isInteger(index) || index < 0 || index >= this.count) {
      throw new RangeError('Body spin index is out of range.');
    }
    return this.spinAnglesRad[index] as number;
  }
}
