import { clamp } from './cameraTransition.js';
import type { OrbitCameraController } from './orbitCameraController.js';

/** Field-of-view envelope of the photo camera (plan §5 T0125). */
export const CINEMATIC_MIN_FOV_DEG = 20;
export const CINEMATIC_MAX_FOV_DEG = 90;
/** Degrees per second while a field-of-view key is held. */
export const CINEMATIC_FOV_RATE_DEG_PER_SEC = 20;
/** Radians per second while a roll key is held; ~46 deg/s, a hand-rolled camera. */
export const CINEMATIC_ROLL_RATE_RAD_PER_SEC = 0.8;
/**
 * Idle drift rate, radians per second of azimuth.
 *
 * 0.02 rad/s is 1.15 deg/s: one revolution in 5 min 14 s — slow enough to read as
 * a camera on a dolly rather than a turntable. Exported because T0148's menu
 * backdrop is specified to reuse this idle.
 */
export const CINEMATIC_DRIFT_RATE_RAD_PER_SEC = 0.02;
/** Quiet wall seconds before the drift starts. */
export const CINEMATIC_DRIFT_IDLE_DELAY_SEC = 2.5;

const TWO_PI = Math.PI * 2;

interface MutableVec3 {
  x: number;
  y: number;
  z: number;
}

export interface CinematicCameraControllerOptions {
  readonly orbit: OrbitCameraController;
  /** Scene base field of view; the mode opens at this value, clamped to the envelope. */
  readonly baseFovDeg: number;
}

/**
 * The looking-not-flying camera: the existing orbit controller plus roll, field
 * of view and an idle drift (spec §5.3, plan §5 T0125).
 *
 * It deliberately owns **no** position state. `CameraDirector` already runs one
 * `OrbitCameraController` every frame and points it at the ship in this mode, so
 * this class reads that pose and adds only what orbiting does not give you.
 *
 * The up vector is derived rather than inherited. Observatory publishes a literal
 * `(0, 1, 0)` — v1's implicit three.js default, which T0110 preserved bit-for-bit
 * — and that vector is neither perpendicular to the look direction nor a usable
 * roll reference (it degenerates entirely when the camera looks along ±Y). This
 * controller instead takes the orbit frame's own pitch tangent
 * `(-sinP·cosY, -sinP·sinY, cosP)`, which is orthogonal to the look direction by
 * construction and points at ecliptic north, and rotates it about the look axis
 * by the roll angle. Rodrigues reduces to `u·cosθ + (L×u)·sinθ` because `L·u = 0`.
 *
 * Allocation-free: every update writes into the preallocated `upDirection`.
 *
 * Design: `docs/superpowers/specs/2026-08-16-cinematic-photo-mode-design.md` §2.
 */
export class CinematicCameraController {
  readonly upDirection: MutableVec3 = { x: 0, y: 0, z: 1 };

  private readonly orbit: OrbitCameraController;
  private rollRadValue = 0;
  private fovDegValue: number;
  private idleSec = 0;
  private driftActive = false;

  constructor(options: CinematicCameraControllerOptions) {
    if (!Number.isFinite(options.baseFovDeg) || options.baseFovDeg <= 0) {
      throw new RangeError('Cinematic camera base field of view must be finite and positive.');
    }
    this.orbit = options.orbit;
    this.fovDegValue = clamp(options.baseFovDeg, CINEMATIC_MIN_FOV_DEG, CINEMATIC_MAX_FOV_DEG);
    this.writeUpDirection();
  }

  /** Camera position and look direction come straight from the orbit controller. */
  get cameraPositionKm(): Readonly<MutableVec3> {
    return this.orbit.cameraPositionKm;
  }

  get lookDirection(): Readonly<MutableVec3> {
    return this.orbit.lookDirection;
  }

  get rollRad(): number {
    return this.rollRadValue;
  }

  get fovDeg(): number {
    return this.fovDegValue;
  }

  /** True while the idle drift is actually moving the camera; read by the diagnostic. */
  get drifting(): boolean {
    return this.driftActive;
  }

  rollBy(deltaRad: number): void {
    if (!Number.isFinite(deltaRad)) throw new RangeError('Cinematic roll delta must be finite.');
    if (deltaRad === 0) return;
    this.rollRadValue = (this.rollRadValue + deltaRad) % TWO_PI;
    this.noteInteraction();
    this.writeUpDirection();
  }

  /** Positive widens; the envelope is the acceptance criterion's 20°–90°. */
  adjustFovBy(deltaDeg: number): void {
    if (!Number.isFinite(deltaDeg)) {
      throw new RangeError('Cinematic field-of-view delta must be finite.');
    }
    if (deltaDeg === 0) return;
    this.fovDegValue = clamp(
      this.fovDegValue + deltaDeg,
      CINEMATIC_MIN_FOV_DEG,
      CINEMATIC_MAX_FOV_DEG,
    );
    this.noteInteraction();
  }

  /** Orbit input arrives through the director; this is how the drift learns about it. */
  noteInteraction(): void {
    this.idleSec = 0;
    this.driftActive = false;
  }

  /** Restores the neutral framing; used when the mode is entered afresh. */
  reset(): void {
    this.rollRadValue = 0;
    this.noteInteraction();
    this.writeUpDirection();
  }

  /**
   * @param active whether cinematic is the mode currently driving the frame. The
   *   pose stays live in every mode — the director cross-fades from live poses —
   *   but the drift must not silently re-aim the shared orbit camera while the
   *   player is watching a different one.
   */
  update(wallDtSec: number, active: boolean): void {
    if (!Number.isFinite(wallDtSec) || wallDtSec < 0) {
      throw new RangeError('Cinematic camera update delta must be finite and nonnegative.');
    }
    if (!active) {
      this.idleSec = 0;
      this.driftActive = false;
      this.writeUpDirection();
      return;
    }
    this.idleSec += wallDtSec;
    if (this.idleSec >= CINEMATIC_DRIFT_IDLE_DELAY_SEC && wallDtSec > 0) {
      this.driftActive = true;
      // Through the orbit controller, so the drifted bearing is the controller's
      // real state and the camera position stays consistent with it.
      this.orbit.orbitBy(CINEMATIC_DRIFT_RATE_RAD_PER_SEC * wallDtSec, 0);
    }
    this.writeUpDirection();
  }

  private writeUpDirection(): void {
    const look = this.orbit.lookDirection;
    // The orbit frame's pitch tangent: -d(look)/d(pitch), unit by construction.
    const lookXY = Math.hypot(look.x, look.y);
    let baseX: number;
    let baseY: number;
    let baseZ: number;
    if (lookXY > 0) {
      // look = -(cosP cosY, cosP sinY, sinP) ⇒ up = (-sinP cosY, -sinP sinY, cosP)
      const cosY = -look.x / lookXY;
      const sinY = -look.y / lookXY;
      const sinPitch = -look.z;
      const cosPitch = lookXY;
      baseX = -sinPitch * cosY;
      baseY = -sinPitch * sinY;
      baseZ = cosPitch;
    } else {
      // Straight up or straight down the ecliptic axis: the tangent is degenerate,
      // so fall back to +X, which is still orthogonal to the look direction.
      baseX = 1;
      baseY = 0;
      baseZ = 0;
    }
    const cosRoll = Math.cos(this.rollRadValue);
    const sinRoll = Math.sin(this.rollRadValue);
    // Rodrigues about the look axis; the `L·u` term vanishes because L ⟂ u.
    const crossX = look.y * baseZ - look.z * baseY;
    const crossY = look.z * baseX - look.x * baseZ;
    const crossZ = look.x * baseY - look.y * baseX;
    this.upDirection.x = baseX * cosRoll + crossX * sinRoll;
    this.upDirection.y = baseY * cosRoll + crossY * sinRoll;
    this.upDirection.z = baseZ * cosRoll + crossZ * sinRoll;
  }
}
