import { writeForwardFromQuaternionInto, writeUpFromQuaternionInto } from '../sim/ship/attitude.js';
import { clamp, firstOrderLagBlend, slerpQuaternionInto } from './cameraTransition.js';
import { minimumCameraDistanceKm } from './orbitCameraController.js';

/** Closest the arm may be pulled in, in ship lengths (plan §T0110 acceptance). */
export const CHASE_MIN_DISTANCE_SHIP_LENGTHS = 2;
/** Furthest the arm may be pushed out, in ship lengths. */
export const CHASE_MAX_DISTANCE_SHIP_LENGTHS = 50;
/**
 * Default arm length.
 *
 * At 6 ship lengths (156.7 m) a 26.12 m hull subtends about 91 px in a 720 p
 * viewport at the scene's 75 deg vertical field — well past `visualTier`'s
 * resolve threshold, and still leaving most of the frame for where you are going.
 */
export const CHASE_DEFAULT_DISTANCE_SHIP_LENGTHS = 6;

/** `position = ship - forward*d + up*0.35d` — the `0.35`. */
export const CHASE_UP_OFFSET_RATIO = 0.35;

/**
 * Undamped natural frequency of the arm spring, rad/s.
 *
 * Derived from the acceptance criterion rather than tuned by eye: a critically
 * damped step decays as `(1 + wt)e^-wt`, which reaches 2 % of the step at
 * `wt = 5.834`, so `w = 8` settles in 0.729 s against the 0.8 s budget. The
 * matching time constant (125 ms) sits just behind the 120 ms attitude lag, so
 * the arm reacts at about the rate of the frame it hangs from instead of
 * fighting it.
 */
export const CHASE_SPRING_OMEGA_RAD_S = 8;

/** First-order lag applied to the followed attitude (plan §T0110 acceptance). */
export const CHASE_ATTITUDE_LAG_SEC = 0.12;

/** Widest the field of view opens at full throttle, degrees. */
export const CHASE_FOV_WIDEN_MAX_DEG = 8;
/** Wall time a field-of-view step takes to reach 98 % of its target. */
export const CHASE_FOV_SMOOTHING_SEC = 0.5;
/** Time constant that puts 98 % of a step inside {@link CHASE_FOV_SMOOTHING_SEC}. */
const CHASE_FOV_TIME_CONSTANT_SEC = CHASE_FOV_SMOOTHING_SEC / Math.log(50);

/** Peak angular deviation of the shake, degrees. */
export const CHASE_SHAKE_MAX_DEG = 0.15;
/**
 * Proper acceleration at which the shake saturates, m/s^2.
 *
 * 5 g, written as an exact decimal literal for the same reason
 * `DEFAULT_VESSEL.alphaMaxMS2` is: `5 * 9.80665` is not bit-identical to
 * `49.03325` in float64, and the literal is the contract.
 */
export const CHASE_SHAKE_FULL_ACCELERATION_MS2 = 49.03325;
/** Envelope frequency of the shake, Hz — how often it swells and fades. */
const CHASE_SHAKE_ENVELOPE_HZ = 8.5;
/** Rotation frequency of the shake, Hz — how fast the wobble direction turns. */
const CHASE_SHAKE_ROTATION_HZ = 5.3;

/** Same exponential wheel law the orbit camera uses, so zoom feels identical. */
const CHASE_WHEEL_EXPONENT_PER_DELTA = 0.0015;

/** Total elevation clamp for the arm, radians (85 deg) — short of the poles. */
const CHASE_MAX_ELEVATION_RAD = 1.483_529_864_195_004_5;
/** Elevation of the authored `+up*0.35d` arm above the "directly behind" line. */
const CHASE_BASE_ELEVATION_RAD = Math.atan(CHASE_UP_OFFSET_RATIO);

const TWO_PI = Math.PI * 2;

interface MutableVec3 {
  x: number;
  y: number;
  z: number;
}

export interface ChaseCameraControllerOptions {
  /**
   * Packed float64 positions: one triple per catalog body (body `i` at `3i`),
   * then the ship. The same array `spaceScene`, `solarLighting` and the orbit
   * camera already read, so the chase arm needs no parallel position machinery.
   */
  readonly positionsKm: Float64Array;
  /** Component offset of the ship's triple in {@link positionsKm}. */
  readonly shipPositionOffset: number;
  /** Hull length in kilometres; the unit the arm distance is expressed in. */
  readonly shipLengthKm: number;
  /**
   * Mean radius per catalog body, indexed like {@link positionsKm}'s body prefix.
   *
   * Injected rather than imported: `game/` may not reach into `render/`, and the
   * catalog is assembled there.
   */
  readonly bodyRadiiKm: Float64Array;
  readonly initialDistanceShipLengths?: number;
}

/**
 * Spring-arm chase camera (T0110), float64 and allocation-free.
 *
 * Follows the ship's *attitude* with a first-order lag and its *position*
 * rigidly: the damped quantity is the arm offset `camera - ship`, never the
 * world position. Springing the world position would give a critically damped
 * tracker a steady-state error of `2v/w` behind a moving target — 1.9 km at LEO
 * orbital speed against a 157 m arm, which would put the ship permanently off
 * screen.
 *
 * Design and derivations: `docs/superpowers/specs/2026-08-15-chase-camera-design.md`.
 */
export class ChaseCameraController {
  /** Heliocentric ecliptic camera position, kilometres. */
  readonly cameraPositionKm: MutableVec3 = { x: 0, y: 0, z: 0 };
  /**
   * The ship position this frame's pose was built around.
   *
   * Republished here rather than left for callers to re-read out of
   * `positionsKm`, so `CameraDirector`'s cross-fade anchors on exactly the point
   * this controller used and cannot drift a frame out of step with it.
   */
  readonly subjectPositionKm: MutableVec3 = { x: 0, y: 0, z: 0 };
  /** Unit direction from the camera to the ship. */
  readonly lookDirection: MutableVec3 = { x: 0, y: 0, z: -1 };
  /** Unit camera up, orthogonal to {@link lookDirection}; carries the ship's roll. */
  readonly upDirection: MutableVec3 = { x: 0, y: 0, z: 1 };

  private readonly positionsKm: Float64Array;
  private readonly shipPositionOffset: number;
  private readonly shipLengthKm: number;
  private readonly bodyRadiiKm: Float64Array;

  private readonly armQuaternion = new Float64Array([0, 0, 0, 1]);
  private readonly forwardScratch = new Float64Array(3);
  private readonly upScratch = new Float64Array(3);

  private armOffsetXKm = 0;
  private armOffsetYKm = 0;
  private armOffsetZKm = 0;
  private armVelocityXKmS = 0;
  private armVelocityYKmS = 0;
  private armVelocityZKmS = 0;

  private distanceShipLengthsValue: number;
  private azimuthOffsetRad = 0;
  private elevationOffsetRad = 0;
  private fovOffsetDegValue = 0;
  private attitudeLagRadValue = 0;
  private shakePhaseSec = 0;
  private shakeAmplitudeDegValue = 0;
  private fovWideningEnabledValue = true;
  private shakeEnabledValue = true;
  private initialized = false;

  constructor(options: ChaseCameraControllerOptions) {
    const { positionsKm, shipPositionOffset } = options;
    if (
      !Number.isInteger(shipPositionOffset) ||
      shipPositionOffset < 0 ||
      shipPositionOffset % 3 !== 0 ||
      shipPositionOffset + 2 >= positionsKm.length
    ) {
      throw new RangeError('Chase camera ship offset must address one packed xyz triple.');
    }
    if (!Number.isFinite(options.shipLengthKm) || options.shipLengthKm <= 0) {
      throw new RangeError('Chase camera ship length must be finite and positive.');
    }
    if (options.bodyRadiiKm.length * 3 > positionsKm.length) {
      throw new RangeError('Chase camera body radii must index the packed position prefix.');
    }
    this.positionsKm = positionsKm;
    this.shipPositionOffset = shipPositionOffset;
    this.shipLengthKm = options.shipLengthKm;
    this.bodyRadiiKm = options.bodyRadiiKm;
    this.distanceShipLengthsValue = clamp(
      options.initialDistanceShipLengths ?? CHASE_DEFAULT_DISTANCE_SHIP_LENGTHS,
      CHASE_MIN_DISTANCE_SHIP_LENGTHS,
      CHASE_MAX_DISTANCE_SHIP_LENGTHS,
    );
  }

  /** Arm length in ship lengths, clamped to `[2, 50]`. */
  get distanceShipLengths(): number {
    return this.distanceShipLengthsValue;
  }

  /** Current straight-line camera-to-ship separation, kilometres. */
  get armDistanceKm(): number {
    return Math.hypot(this.armOffsetXKm, this.armOffsetYKm, this.armOffsetZKm);
  }

  /** Degrees to add to the scene's base vertical field of view this frame. */
  get fovOffsetDeg(): number {
    return this.fovOffsetDegValue;
  }

  /** Peak angular deviation the shake is currently allowed, degrees. */
  get shakeAmplitudeDeg(): number {
    return this.shakeAmplitudeDegValue;
  }

  /**
   * Angle between the arm's followed attitude and the ship's, radians.
   *
   * This *is* the "120 ms lag" acceptance criterion, made observable: under a
   * constant turn rate it settles at `rate * 0.12 s`.
   */
  get attitudeLagRad(): number {
    return this.attitudeLagRadValue;
  }

  get fovWideningEnabled(): boolean {
    return this.fovWideningEnabledValue;
  }

  get shakeEnabled(): boolean {
    return this.shakeEnabledValue;
  }

  setFovWideningEnabled(enabled: boolean): void {
    this.fovWideningEnabledValue = enabled;
  }

  setShakeEnabled(enabled: boolean): void {
    this.shakeEnabledValue = enabled;
    if (!enabled) this.shakeAmplitudeDegValue = 0;
  }

  setDistanceShipLengths(distanceShipLengths: number): void {
    if (!Number.isFinite(distanceShipLengths)) {
      throw new RangeError('Chase camera distance must be finite.');
    }
    this.distanceShipLengthsValue = clamp(
      distanceShipLengths,
      CHASE_MIN_DISTANCE_SHIP_LENGTHS,
      CHASE_MAX_DISTANCE_SHIP_LENGTHS,
    );
  }

  zoomByWheel(wheelDelta: number): void {
    if (!Number.isFinite(wheelDelta)) throw new RangeError('Chase wheel delta must be finite.');
    this.setDistanceShipLengths(
      this.distanceShipLengthsValue * Math.exp(wheelDelta * CHASE_WHEEL_EXPONENT_PER_DELTA),
    );
  }

  /**
   * Swings the arm around the ship without breaking attitude follow.
   *
   * The offsets are applied *inside* the lagged ship frame, so a player who has
   * dragged the camera off to one side keeps that relative bearing through every
   * manoeuvre. They persist until the mode changes.
   */
  orbitBy(deltaAzimuthRad: number, deltaElevationRad: number): void {
    if (!Number.isFinite(deltaAzimuthRad) || !Number.isFinite(deltaElevationRad)) {
      throw new RangeError('Chase camera orbit deltas must be finite.');
    }
    this.azimuthOffsetRad = (this.azimuthOffsetRad + deltaAzimuthRad) % TWO_PI;
    // Clamped so the *total* elevation stays inside +/-85 deg, which is why the
    // limits are asymmetric: the arm already sits 19.3 deg high at rest.
    this.elevationOffsetRad = clamp(
      this.elevationOffsetRad + deltaElevationRad,
      -CHASE_MAX_ELEVATION_RAD - CHASE_BASE_ELEVATION_RAD,
      CHASE_MAX_ELEVATION_RAD - CHASE_BASE_ELEVATION_RAD,
    );
  }

  /** Returns the arm to the authored bearing; used when a mode change re-enters chase. */
  resetArmOffsets(): void {
    this.azimuthOffsetRad = 0;
    this.elevationOffsetRad = 0;
  }

  /**
   * Drops the spring, the attitude lag and the shake phase.
   *
   * The next `update` snaps to the exact commanded pose instead of easing into
   * it, which is what a first frame — or a restore that teleports the ship —
   * needs. Without it the camera would spend 0.7 s flying in from wherever the
   * previous mission left the arm.
   */
  reset(): void {
    this.initialized = false;
    this.armVelocityXKmS = 0;
    this.armVelocityYKmS = 0;
    this.armVelocityZKmS = 0;
    this.shakePhaseSec = 0;
    this.fovOffsetDegValue = 0;
    this.shakeAmplitudeDegValue = 0;
    this.attitudeLagRadValue = 0;
  }

  /**
   * Advances one frame and writes the pose. Allocation-free.
   *
   * @param wallDtSec wall-clock frame delta (never sim time: the camera is a
   *   presentation object and must not speed up under time warp)
   * @param attitudeQuaternion ship body-to-inertial quaternion, xyzw
   * @param throttle01 commanded throttle, drives the field-of-view widening
   * @param properAccelerationMS2 magnitude of proper acceleration, drives the shake
   * @param clearanceBodyIndex catalog body to keep the camera outside of, or -1
   * @param frozen true while the simulation is halted by a surface impact
   */
  update(
    wallDtSec: number,
    attitudeQuaternion: Float64Array,
    throttle01: number,
    properAccelerationMS2: number,
    clearanceBodyIndex: number,
    frozen: boolean,
  ): void {
    if (!Number.isFinite(wallDtSec) || wallDtSec < 0) {
      throw new RangeError('Chase camera update delta must be finite and nonnegative.');
    }
    const shipXKm = this.positionsKm[this.shipPositionOffset] as number;
    const shipYKm = this.positionsKm[this.shipPositionOffset + 1] as number;
    const shipZKm = this.positionsKm[this.shipPositionOffset + 2] as number;
    if (!Number.isFinite(shipXKm) || !Number.isFinite(shipYKm) || !Number.isFinite(shipZKm)) {
      throw new RangeError('Chase camera ship position must be finite.');
    }
    this.subjectPositionKm.x = shipXKm;
    this.subjectPositionKm.y = shipYKm;
    this.subjectPositionKm.z = shipZKm;

    this.advanceAttitude(wallDtSec, attitudeQuaternion, frozen);
    writeForwardFromQuaternionInto(this.forwardScratch, this.armQuaternion);
    writeUpFromQuaternionInto(this.upScratch, this.armQuaternion);
    const forwardX = this.forwardScratch[0] as number;
    const forwardY = this.forwardScratch[1] as number;
    const forwardZ = this.forwardScratch[2] as number;
    const upX = this.upScratch[0] as number;
    const upY = this.upScratch[1] as number;
    const upZ = this.upScratch[2] as number;
    // Left-handed-out-of-the-page in the ADR-025 body frame: with +X forward and
    // +Z up, up x forward is +Y, the vessel's left.
    const leftX = upY * forwardZ - upZ * forwardY;
    const leftY = upZ * forwardX - upX * forwardZ;
    const leftZ = upX * forwardY - upY * forwardX;

    // `-forward*d + up*0.35d`, rotated inside the body frame by the player's
    // azimuth/elevation offsets so a dragged camera keeps its bearing through a
    // manoeuvre.
    //
    // Written with the `sqrt(1 + 0.35^2)` normalisation cancelled out rather than
    // as `cos/sin` of an absolute elevation: at zero offset the components reduce
    // to `-1`, `0` and `0.35` times `d`, which reproduces the spec vector to the
    // last bit instead of to the 1e-12 an `atan`/`cos` round trip leaves behind.
    // It also drops an `atan` from the frame path.
    const cosPitch = Math.cos(this.elevationOffsetRad);
    const sinPitch = Math.sin(this.elevationOffsetRad);
    const horizontal = cosPitch - CHASE_UP_OFFSET_RATIO * sinPitch;
    const vertical = CHASE_UP_OFFSET_RATIO * cosPitch + sinPitch;
    const bodyForward = -horizontal * Math.cos(this.azimuthOffsetRad);
    const bodyLeft = -horizontal * Math.sin(this.azimuthOffsetRad);
    const bodyUp = vertical;
    const armScaleKm = this.distanceShipLengthsValue * this.shipLengthKm;
    const desiredXKm = (bodyForward * forwardX + bodyLeft * leftX + bodyUp * upX) * armScaleKm;
    const desiredYKm = (bodyForward * forwardY + bodyLeft * leftY + bodyUp * upY) * armScaleKm;
    const desiredZKm = (bodyForward * forwardZ + bodyLeft * leftZ + bodyUp * upZ) * armScaleKm;

    if (!this.initialized) {
      this.armOffsetXKm = desiredXKm;
      this.armOffsetYKm = desiredYKm;
      this.armOffsetZKm = desiredZKm;
      this.armVelocityXKmS = 0;
      this.armVelocityYKmS = 0;
      this.armVelocityZKmS = 0;
      this.initialized = true;
    } else if (wallDtSec > 0) {
      this.integrateSpring(wallDtSec, desiredXKm, desiredYKm, desiredZKm);
    }

    let cameraXKm = shipXKm + this.armOffsetXKm;
    let cameraYKm = shipYKm + this.armOffsetYKm;
    let cameraZKm = shipZKm + this.armOffsetZKm;

    // Surface standoff. Applied to the *output* rather than to the spring state,
    // so a pinned arm slides along the surface and lets go smoothly when the ship
    // climbs, instead of the spring integrating against a wall.
    const radiusKm = this.bodyRadiiKm[clearanceBodyIndex];
    if (clearanceBodyIndex >= 0 && radiusKm !== undefined && radiusKm > 0) {
      const bodyOffset = clearanceBodyIndex * 3;
      const bodyXKm = this.positionsKm[bodyOffset] as number;
      const bodyYKm = this.positionsKm[bodyOffset + 1] as number;
      const bodyZKm = this.positionsKm[bodyOffset + 2] as number;
      const toCameraXKm = cameraXKm - bodyXKm;
      const toCameraYKm = cameraYKm - bodyYKm;
      const toCameraZKm = cameraZKm - bodyZKm;
      const separationKm = Math.hypot(toCameraXKm, toCameraYKm, toCameraZKm);
      const minimumKm = minimumCameraDistanceKm(radiusKm);
      if (separationKm > 0 && separationKm < minimumKm) {
        const scale = minimumKm / separationKm;
        cameraXKm = bodyXKm + toCameraXKm * scale;
        cameraYKm = bodyYKm + toCameraYKm * scale;
        cameraZKm = bodyZKm + toCameraZKm * scale;
      }
    }

    this.cameraPositionKm.x = cameraXKm;
    this.cameraPositionKm.y = cameraYKm;
    this.cameraPositionKm.z = cameraZKm;

    // Measured from the clamped position, so the ship stays centred even while
    // the arm is pinned against a surface.
    let lookX = shipXKm - cameraXKm;
    let lookY = shipYKm - cameraYKm;
    let lookZ = shipZKm - cameraZKm;
    const lookLength = Math.hypot(lookX, lookY, lookZ);
    if (lookLength > 0) {
      lookX /= lookLength;
      lookY /= lookLength;
      lookZ /= lookLength;
    } else {
      lookX = forwardX;
      lookY = forwardY;
      lookZ = forwardZ;
    }

    const upDot = upX * lookX + upY * lookY + upZ * lookZ;
    let cameraUpX = upX - lookX * upDot;
    let cameraUpY = upY - lookY * upDot;
    let cameraUpZ = upZ - lookZ * upDot;
    const upLength = Math.hypot(cameraUpX, cameraUpY, cameraUpZ);
    if (upLength > 0) {
      cameraUpX /= upLength;
      cameraUpY /= upLength;
      cameraUpZ /= upLength;
    } else {
      cameraUpX = upX;
      cameraUpY = upY;
      cameraUpZ = upZ;
    }

    this.applyShake(
      wallDtSec,
      properAccelerationMS2,
      frozen,
      lookX,
      lookY,
      lookZ,
      cameraUpX,
      cameraUpY,
      cameraUpZ,
    );
    this.advanceFieldOfView(wallDtSec, throttle01);
  }

  private advanceAttitude(
    wallDtSec: number,
    attitudeQuaternion: Float64Array,
    frozen: boolean,
  ): void {
    const x = attitudeQuaternion[0] as number;
    const y = attitudeQuaternion[1] as number;
    const z = attitudeQuaternion[2] as number;
    const w = attitudeQuaternion[3] as number;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z) || !Number.isFinite(w)) {
      throw new RangeError('Chase camera attitude quaternion must be finite.');
    }
    if (!this.initialized) {
      this.armQuaternion[0] = x;
      this.armQuaternion[1] = y;
      this.armQuaternion[2] = z;
      this.armQuaternion[3] = w;
      this.attitudeLagRadValue = 0;
      return;
    }
    // A frozen ship has no attitude left to chase; continuing to ease toward it
    // would only replay float noise.
    if (!frozen && wallDtSec > 0) {
      slerpQuaternionInto(
        this.armQuaternion,
        this.armQuaternion,
        attitudeQuaternion,
        firstOrderLagBlend(wallDtSec, CHASE_ATTITUDE_LAG_SEC),
      );
    }
    const dot = Math.abs(
      (this.armQuaternion[0] as number) * x +
        (this.armQuaternion[1] as number) * y +
        (this.armQuaternion[2] as number) * z +
        (this.armQuaternion[3] as number) * w,
    );
    this.attitudeLagRadValue = 2 * Math.acos(clamp(dot, -1, 1));
  }

  /**
   * Exact critically damped step, not an Euler integration.
   *
   * `x(t) = target + (D + B t) e^-wt` with `D = x - target` and `B = v + w D` is
   * the closed-form solution for a constant target, so the step is stable and
   * overshoot-free at any frame delta: `(D + B t)` changes sign only at
   * `t = -D/B`, which is negative whenever `D` and `B` share a sign — always true
   * starting from rest, where `B = w D`.
   */
  private integrateSpring(
    dtSec: number,
    targetXKm: number,
    targetYKm: number,
    targetZKm: number,
  ): void {
    const omega = CHASE_SPRING_OMEGA_RAD_S;
    const decay = Math.exp(-omega * dtSec);

    const deltaXKm = this.armOffsetXKm - targetXKm;
    const rateXKmS = this.armVelocityXKmS + omega * deltaXKm;
    const displacedXKm = deltaXKm + rateXKmS * dtSec;
    this.armOffsetXKm = targetXKm + displacedXKm * decay;
    this.armVelocityXKmS = (rateXKmS - omega * displacedXKm) * decay;

    const deltaYKm = this.armOffsetYKm - targetYKm;
    const rateYKmS = this.armVelocityYKmS + omega * deltaYKm;
    const displacedYKm = deltaYKm + rateYKmS * dtSec;
    this.armOffsetYKm = targetYKm + displacedYKm * decay;
    this.armVelocityYKmS = (rateYKmS - omega * displacedYKm) * decay;

    const deltaZKm = this.armOffsetZKm - targetZKm;
    const rateZKmS = this.armVelocityZKmS + omega * deltaZKm;
    const displacedZKm = deltaZKm + rateZKmS * dtSec;
    this.armOffsetZKm = targetZKm + displacedZKm * decay;
    this.armVelocityZKmS = (rateZKmS - omega * displacedZKm) * decay;
  }

  /**
   * Writes the shaken look/up frame.
   *
   * The two components are `A sin(e) cos(r)` and `A sin(e) sin(r)`, so their
   * magnitude is `A |sin(e)|` — bounded by `A` *exactly*. Two independent
   * sinusoids of amplitude `A` would instead peak at `A sqrt(2)`, quietly
   * breaking the 0.15 deg contract by 41 %.
   */
  private applyShake(
    wallDtSec: number,
    properAccelerationMS2: number,
    frozen: boolean,
    lookX: number,
    lookY: number,
    lookZ: number,
    upX: number,
    upY: number,
    upZ: number,
  ): void {
    let amplitudeDeg = 0;
    if (this.shakeEnabledValue && Number.isFinite(properAccelerationMS2) && !frozen) {
      amplitudeDeg =
        CHASE_SHAKE_MAX_DEG *
        clamp(Math.abs(properAccelerationMS2) / CHASE_SHAKE_FULL_ACCELERATION_MS2, 0, 1);
      this.shakePhaseSec += wallDtSec;
    }
    this.shakeAmplitudeDegValue = amplitudeDeg;
    if (amplitudeDeg === 0) {
      this.lookDirection.x = lookX;
      this.lookDirection.y = lookY;
      this.lookDirection.z = lookZ;
      this.upDirection.x = upX;
      this.upDirection.y = upY;
      this.upDirection.z = upZ;
      return;
    }

    const amplitudeRad = amplitudeDeg * (Math.PI / 180);
    const envelope = Math.sin(TWO_PI * CHASE_SHAKE_ENVELOPE_HZ * this.shakePhaseSec);
    const rotation = TWO_PI * CHASE_SHAKE_ROTATION_HZ * this.shakePhaseSec;
    const pitchRad = amplitudeRad * envelope * Math.cos(rotation);
    const yawRad = amplitudeRad * envelope * Math.sin(rotation);

    const rightX = lookY * upZ - lookZ * upY;
    const rightY = lookZ * upX - lookX * upZ;
    const rightZ = lookX * upY - lookY * upX;

    // First-order rotation about the camera right and up axes. At 0.15 deg the
    // truncation error is 3.4e-6 rad, four orders below the amplitude itself.
    let shakenLookX = lookX + yawRad * rightX + pitchRad * upX;
    let shakenLookY = lookY + yawRad * rightY + pitchRad * upY;
    let shakenLookZ = lookZ + yawRad * rightZ + pitchRad * upZ;
    const lookLength = Math.hypot(shakenLookX, shakenLookY, shakenLookZ);
    shakenLookX /= lookLength;
    shakenLookY /= lookLength;
    shakenLookZ /= lookLength;

    let shakenUpX = upX - pitchRad * lookX;
    let shakenUpY = upY - pitchRad * lookY;
    let shakenUpZ = upZ - pitchRad * lookZ;
    const upDot = shakenUpX * shakenLookX + shakenUpY * shakenLookY + shakenUpZ * shakenLookZ;
    shakenUpX -= shakenLookX * upDot;
    shakenUpY -= shakenLookY * upDot;
    shakenUpZ -= shakenLookZ * upDot;
    const upLength = Math.hypot(shakenUpX, shakenUpY, shakenUpZ);

    this.lookDirection.x = shakenLookX;
    this.lookDirection.y = shakenLookY;
    this.lookDirection.z = shakenLookZ;
    this.upDirection.x = shakenUpX / upLength;
    this.upDirection.y = shakenUpY / upLength;
    this.upDirection.z = shakenUpZ / upLength;
  }

  private advanceFieldOfView(wallDtSec: number, throttle01: number): void {
    const targetDeg = this.fovWideningEnabledValue
      ? CHASE_FOV_WIDEN_MAX_DEG * clamp(Number.isFinite(throttle01) ? throttle01 : 0, 0, 1)
      : 0;
    if (wallDtSec === 0) return;
    this.fovOffsetDegValue +=
      (targetDeg - this.fovOffsetDegValue) *
      firstOrderLagBlend(wallDtSec, CHASE_FOV_TIME_CONSTANT_SEC);
  }
}
