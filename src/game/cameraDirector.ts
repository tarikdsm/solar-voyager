import type { ReadonlyVec3 } from '../core/vec3.js';
import type { SimSnapshot } from '../sim/simulationSnapshot.js';
import type { ChaseCameraController } from './chaseCameraController.js';
import {
  interpolateLogarithmic,
  slerpUnitDirectionInto,
  smootherstep,
} from './cameraTransition.js';
import { CinematicCameraController } from './cinematicCameraController.js';
import {
  DEFAULT_TRANSFER_DURATION_SEC,
  type OrbitCameraController,
} from './orbitCameraController.js';
import type { CameraSettings } from './settings.js';

/** Plan §2 shared contract. `cockpit` arrives with T0124. */
export type CameraMode = 'chase' | 'cockpit' | 'cinematic' | 'observatory';

/**
 * The modes this build implements, in the order `cycle()` walks them.
 *
 * Spec §5 fixes the ring as chase → cockpit → cinematic, with observatory reached
 * from the map and the camera menu; observatory sits last so T0124 can insert
 * `cockpit` at index 1 without moving anything else.
 */
export const IMPLEMENTED_CAMERA_MODES: readonly CameraMode[] = Object.freeze([
  'chase',
  'cinematic',
  'observatory',
] as const);

/** Task that owns each mode this build does not implement yet. */
const PENDING_CAMERA_MODE_OWNERS: Readonly<Record<string, string>> = Object.freeze({
  cockpit: 'T0124',
});

/**
 * Everything the render layer needs to place one camera for one frame.
 *
 * `upDirection` follows three.js `Object3D.lookAt` semantics: it is an *up hint*
 * and need not be orthogonal to `lookDirection`. Observatory reports the scene
 * camera's default `+Y`, which is what v1 used implicitly, so nothing about the
 * orbit camera's framing moves.
 */
export interface CameraPose {
  readonly positionKm: ReadonlyVec3;
  readonly lookDirection: ReadonlyVec3;
  readonly upDirection: ReadonlyVec3;
  readonly fovDeg: number;
}

interface MutablePose {
  positionKm: { x: number; y: number; z: number };
  lookDirection: { x: number; y: number; z: number };
  upDirection: { x: number; y: number; z: number };
  fovDeg: number;
}

/** Snapshot accelerations are km/s^2; the shake ramp is specified in m/s^2. */
const KM_TO_M = 1000;

export interface CameraDirectorOptions {
  readonly orbit: OrbitCameraController;
  readonly chase: ChaseCameraController;
  /** Focus-ring id of the ship (`SHIP_ASSET_ID`), injected: it lives in `render/`. */
  readonly shipFocusId: string;
  /** Component offset of the ship's triple in the shared packed positions. */
  readonly shipPositionOffset: number;
  /** Scene base vertical field of view, degrees, before chase widening. */
  readonly baseFovDeg: number;
  readonly initialMode?: CameraMode;
  readonly transitionDurationSec?: number;
  /** Where `cycle()` sends the observatory camera when it leaves the ship. */
  readonly defaultObservatoryFocusId?: string;
}

function assertImplemented(mode: CameraMode): void {
  if (IMPLEMENTED_CAMERA_MODES.includes(mode)) return;
  const owner = PENDING_CAMERA_MODE_OWNERS[mode];
  throw new RangeError(
    owner === undefined
      ? `Unknown camera mode "${mode}".`
      : `Camera mode "${mode}" is not implemented yet; ${owner} adds it.`,
  );
}

/**
 * Chooses which camera drives the frame and animates every change between them.
 *
 * Both controllers run every frame regardless of mode, so a switch always
 * cross-fades from a live pose to a live pose rather than to one that has been
 * sitting stale — and so the outgoing mode is still correct if the player
 * switches straight back.
 *
 * Focus routing follows one rule: **only the camera input port changes the
 * mode.** `focusBody`/`cycleFocus` come from drag, wheel and the camera keys and
 * may switch modes; `focusObservatoryBody` comes from `Commands.setTarget` and
 * the system map and only re-aims the observatory camera, so choosing a
 * navigation target no longer throws you out of the chase view.
 *
 * Design: `docs/superpowers/specs/2026-08-15-chase-camera-design.md`.
 */
export class CameraDirector {
  private readonly orbit: OrbitCameraController;
  private readonly chase: ChaseCameraController;
  private readonly cinematic: CinematicCameraController;
  private readonly shipFocusId: string;
  private readonly shipPositionOffset: number;
  private readonly baseFovDeg: number;
  private readonly transitionDurationSec: number;

  private currentMode: CameraMode;
  private lastObservatoryFocusId: string;

  private readonly currentPose: MutablePose = {
    positionKm: { x: 0, y: 0, z: 0 },
    lookDirection: { x: 0, y: 0, z: -1 },
    upDirection: { x: 0, y: 1, z: 0 },
    fovDeg: 0,
  };

  private readonly directionScratch = new Float64Array(3);
  private readonly lookScratch = new Float64Array(3);
  private readonly upScratch = new Float64Array(3);

  private posePublished = false;
  private transitionActive = false;
  private transitionElapsedSec = 0;
  private transitionStartAnchorXKm = 0;
  private transitionStartAnchorYKm = 0;
  private transitionStartAnchorZKm = 0;
  private transitionStartDirectionX = 0;
  private transitionStartDirectionY = 0;
  private transitionStartDirectionZ = 1;
  private transitionStartDistanceKm = 1;
  private transitionStartLookX = 0;
  private transitionStartLookY = 0;
  private transitionStartLookZ = -1;
  private transitionStartUpX = 0;
  private transitionStartUpY = 1;
  private transitionStartUpZ = 0;
  private transitionStartFovDeg = 0;

  constructor(options: CameraDirectorOptions) {
    if (!Number.isFinite(options.baseFovDeg) || options.baseFovDeg <= 0) {
      throw new RangeError('Camera director base field of view must be finite and positive.');
    }
    if (options.shipFocusId.length === 0) {
      throw new RangeError('Camera director ship focus id cannot be empty.');
    }
    this.transitionDurationSec = options.transitionDurationSec ?? DEFAULT_TRANSFER_DURATION_SEC;
    if (!Number.isFinite(this.transitionDurationSec) || this.transitionDurationSec <= 0) {
      throw new RangeError('Camera director transition duration must be finite and positive.');
    }
    this.orbit = options.orbit;
    this.chase = options.chase;
    this.cinematic = new CinematicCameraController({
      orbit: options.orbit,
      baseFovDeg: options.baseFovDeg,
    });
    this.shipFocusId = options.shipFocusId;
    this.shipPositionOffset = options.shipPositionOffset;
    this.baseFovDeg = options.baseFovDeg;
    this.currentPose.fovDeg = options.baseFovDeg;
    const initialMode = options.initialMode ?? 'chase';
    assertImplemented(initialMode);
    this.currentMode = initialMode;
    const defaultObservatoryFocusId = options.defaultObservatoryFocusId ?? this.orbit.focusId;
    this.lastObservatoryFocusId =
      defaultObservatoryFocusId === this.shipFocusId ? 'earth' : defaultObservatoryFocusId;
    // Keep the orbit camera's ring index on whatever the director is showing, so
    // `[` / `]` walk one ring across both modes.
    if (initialMode === 'chase' || initialMode === 'cinematic') {
      this.orbit.focusBody(this.shipFocusId);
    }
  }

  get mode(): CameraMode {
    return this.currentMode;
  }

  get pose(): CameraPose {
    return this.currentPose;
  }

  /** Live camera position; the identity `EpochWorld.cameraPositionKm` exposes. */
  get cameraPositionKm(): ReadonlyVec3 {
    return this.currentPose.positionKm;
  }

  get isTransitioning(): boolean {
    return this.transitionActive;
  }

  /** What the camera is actually looking at — `ship` in chase, the body otherwise. */
  get focusId(): string {
    return this.currentMode === 'chase' ? this.shipFocusId : this.orbit.focusId;
  }

  /** Packed-position offset of the current subject, for `SolarLighting`. */
  get focusPositionOffset(): number {
    return this.currentMode === 'chase' ? this.shipPositionOffset : this.orbit.focusPositionOffset;
  }

  setMode(mode: CameraMode): void {
    assertImplemented(mode);
    if (mode === this.currentMode) return;
    this.captureTransitionStart();
    this.currentMode = mode;
    if (mode === 'chase') {
      this.chase.resetArmOffsets();
      this.orbit.focusBody(this.shipFocusId);
    } else if (mode === 'cinematic') {
      // The 39 m view of the hull observatory must never show is exactly what
      // photo mode is for.
      this.orbit.focusBody(this.shipFocusId);
      // Roll is a per-shot choice and starts level; the field of view is a lens
      // the player picked and deliberately survives a mode change.
      this.cinematic.reset();
    } else if (this.orbit.focusId === this.shipFocusId) {
      // Never hand the player a 39 m "observatory" view of their own hull.
      this.orbit.focusBody(this.lastObservatoryFocusId);
    }
  }

  cycle(): void {
    const index = IMPLEMENTED_CAMERA_MODES.indexOf(this.currentMode);
    const next = IMPLEMENTED_CAMERA_MODES[(index + 1) % IMPLEMENTED_CAMERA_MODES.length];
    if (next === undefined) throw new Error('Camera mode ring is empty.');
    this.setMode(next);
  }

  /**
   * Explicit camera request from the input port: may change the mode.
   *
   * Returns whether anything moved, matching `OrbitCameraController.focusBody`.
   */
  focusBody(id: string): boolean {
    if (id === this.shipFocusId) {
      if (this.currentMode === 'chase') return false;
      this.setMode('chase');
      return true;
    }
    const previousMode = this.currentMode;
    this.lastObservatoryFocusId = id;
    const orbitChanged = this.orbit.focusBody(id);
    if (previousMode !== 'observatory') this.setMode('observatory');
    return orbitChanged || previousMode !== 'observatory';
  }

  /** Focus-ring step; landing on the ship enters chase, landing off it leaves. */
  cycleFocus(step: number): string {
    const id = this.orbit.cycleFocus(step);
    if (id === this.shipFocusId) {
      this.setMode('chase');
      return id;
    }
    this.lastObservatoryFocusId = id;
    this.setMode('observatory');
    return id;
  }

  /**
   * Re-aims the observatory camera without touching the mode.
   *
   * `Commands.setTarget` and the system map both go through here: picking a
   * navigation target is not a request to change how you are viewing the ship.
   */
  focusObservatoryBody(id: string): boolean {
    if (id === this.shipFocusId) return false;
    this.lastObservatoryFocusId = id;
    if (this.currentMode === 'chase') return false;
    return this.orbit.focusBody(id);
  }

  orbitBy(deltaYawRad: number, deltaPitchRad: number): void {
    if (this.currentMode === 'chase') {
      this.chase.orbitBy(deltaYawRad, deltaPitchRad);
      return;
    }
    this.orbit.orbitBy(deltaYawRad, deltaPitchRad);
    this.cinematic.noteInteraction();
  }

  zoomByWheel(wheelDelta: number): void {
    if (this.currentMode === 'chase') {
      this.chase.zoomByWheel(wheelDelta);
      return;
    }
    this.orbit.zoomByWheel(wheelDelta);
    this.cinematic.noteInteraction();
  }

  /**
   * Camera roll, in radians; ignored outside cinematic (T0125).
   *
   * Reporting whether the input was consumed is what lets `Q`/`E` be camera roll
   * in cinematic and stay free elsewhere without any caller knowing the mode.
   */
  rollCameraBy(deltaRad: number): boolean {
    if (this.currentMode !== 'cinematic') return false;
    this.cinematic.rollBy(deltaRad);
    return true;
  }

  /** Field-of-view nudge inside the cinematic envelope; ignored in other modes. */
  adjustCameraFovBy(deltaDeg: number): boolean {
    if (this.currentMode !== 'cinematic') return false;
    this.cinematic.adjustFovBy(deltaDeg);
    return true;
  }

  /**
   * Whether the hardcoded direct-focus camera keys (`[`, `]`, `E`, `J`) apply.
   *
   * False in cinematic: `E` is that mode's roll-right binding, and every one of
   * those keys would leave the mode anyway, so the mode key is the way out.
   */
  get directFocusEnabled(): boolean {
    return this.currentMode !== 'cinematic';
  }

  /** Cinematic read side, for the frozen `solarVoyagerCamera` browser diagnostic. */
  get cinematicRollRad(): number {
    return this.cinematic.rollRad;
  }

  get cinematicFovDeg(): number {
    return this.cinematic.fovDeg;
  }

  get cinematicDrifting(): boolean {
    return this.cinematic.drifting;
  }

  /** Arm length in ship lengths; surfaced for the browser camera diagnostic. */
  get chaseDistanceShipLengths(): number {
    return this.chase.distanceShipLengths;
  }

  get chaseArmDistanceKm(): number {
    return this.chase.armDistanceKm;
  }

  get chaseFovOffsetDeg(): number {
    return this.chase.fovOffsetDeg;
  }

  get chaseShakeAmplitudeDeg(): number {
    return this.chase.shakeAmplitudeDeg;
  }

  get chaseFovWideningEnabled(): boolean {
    return this.chase.fovWideningEnabled;
  }

  get chaseShakeEnabled(): boolean {
    return this.chase.shakeEnabled;
  }

  /** Applies the persisted presentation toggles; idempotent, safe to re-apply. */
  applyCameraSettings(settings: CameraSettings): void {
    this.chase.setFovWideningEnabled(settings.fovWidening);
    this.chase.setShakeEnabled(settings.shake);
  }

  /** Snaps the chase arm on the next frame; used when a restore teleports the ship. */
  resetChase(): void {
    this.chase.reset();
  }

  /**
   * Publishes a pose before any simulation step exists.
   *
   * `createEpochWorld` rebases the scene and compiles shaders against the camera
   * position, so it needs a real one during setup. Priming with the epoch
   * attitude puts the warm-up camera where the first ordinary frame will be,
   * which is also what keeps `test:startup`'s first-frame program-count
   * assertion honest — a warm-up from somewhere else could miss a shader the
   * first real frame then compiles. The chase arm is reset afterwards so that
   * first frame still snaps to the true attitude instead of easing in from this
   * approximation.
   */
  prime(attitudeQuaternion: Float64Array): void {
    this.orbit.update(0);
    this.chase.update(0, attitudeQuaternion, 0, 0, -1, false);
    this.cinematic.update(0, this.currentMode === 'cinematic');
    this.writeActiveModePose();
    this.chase.reset();
  }

  update(wallDtSec: number, snapshot: SimSnapshot): void {
    if (!Number.isFinite(wallDtSec) || wallDtSec < 0) {
      throw new RangeError('Camera director update delta must be finite and nonnegative.');
    }
    const frozen = snapshot.impactOccurred === 1;
    const clearanceBodyIndex = frozen ? snapshot.impactBodyIndex : snapshot.dominantBodyIndex;
    const accelerationMS2 =
      Math.hypot(
        snapshot.shipProperAccelerationKmS2[0] as number,
        snapshot.shipProperAccelerationKmS2[1] as number,
        snapshot.shipProperAccelerationKmS2[2] as number,
      ) * KM_TO_M;

    // Both run every frame: the incoming mode must already be settled when a
    // switch happens, and the orbit camera keeps tracking its body so the
    // cross-fade always has a live endpoint.
    this.orbit.update(wallDtSec);
    this.chase.update(
      wallDtSec,
      snapshot.attitudeQuaternion,
      snapshot.throttle,
      accelerationMS2,
      clearanceBodyIndex,
      frozen,
    );
    // After the orbit camera, because the cinematic up vector is derived from the
    // orbit frame this step just recomputed.
    this.cinematic.update(wallDtSec, this.currentMode === 'cinematic');

    if (!this.transitionActive) {
      this.writeActiveModePose();
      return;
    }
    this.transitionElapsedSec = Math.min(
      this.transitionDurationSec,
      this.transitionElapsedSec + wallDtSec,
    );
    const time = this.transitionElapsedSec / this.transitionDurationSec;
    if (time >= 1) {
      this.transitionActive = false;
      this.writeActiveModePose();
      return;
    }
    this.writeBlendedPose(smootherstep(time));
  }

  private writeActiveModePose(): void {
    this.posePublished = true;
    if (this.currentMode === 'chase') {
      this.currentPose.positionKm.x = this.chase.cameraPositionKm.x;
      this.currentPose.positionKm.y = this.chase.cameraPositionKm.y;
      this.currentPose.positionKm.z = this.chase.cameraPositionKm.z;
      this.currentPose.lookDirection.x = this.chase.lookDirection.x;
      this.currentPose.lookDirection.y = this.chase.lookDirection.y;
      this.currentPose.lookDirection.z = this.chase.lookDirection.z;
      this.currentPose.upDirection.x = this.chase.upDirection.x;
      this.currentPose.upDirection.y = this.chase.upDirection.y;
      this.currentPose.upDirection.z = this.chase.upDirection.z;
      this.currentPose.fovDeg = this.baseFovDeg + this.chase.fovOffsetDeg;
      return;
    }
    if (this.currentMode === 'cinematic') {
      this.currentPose.positionKm.x = this.orbit.cameraPositionKm.x;
      this.currentPose.positionKm.y = this.orbit.cameraPositionKm.y;
      this.currentPose.positionKm.z = this.orbit.cameraPositionKm.z;
      this.currentPose.lookDirection.x = this.orbit.lookDirection.x;
      this.currentPose.lookDirection.y = this.orbit.lookDirection.y;
      this.currentPose.lookDirection.z = this.orbit.lookDirection.z;
      this.currentPose.upDirection.x = this.cinematic.upDirection.x;
      this.currentPose.upDirection.y = this.cinematic.upDirection.y;
      this.currentPose.upDirection.z = this.cinematic.upDirection.z;
      this.currentPose.fovDeg = this.cinematic.fovDeg;
      return;
    }
    this.currentPose.positionKm.x = this.orbit.cameraPositionKm.x;
    this.currentPose.positionKm.y = this.orbit.cameraPositionKm.y;
    this.currentPose.positionKm.z = this.orbit.cameraPositionKm.z;
    this.currentPose.lookDirection.x = this.orbit.lookDirection.x;
    this.currentPose.lookDirection.y = this.orbit.lookDirection.y;
    this.currentPose.lookDirection.z = this.orbit.lookDirection.z;
    // v1's implicit up: the scene camera's three.js default. Reproducing it
    // exactly keeps every observatory framing bit-identical to before this task.
    this.currentPose.upDirection.x = 0;
    this.currentPose.upDirection.y = 1;
    this.currentPose.upDirection.z = 0;
    this.currentPose.fovDeg = this.baseFovDeg;
  }

  /** Freezes the outgoing pose in anchor/direction/distance form for the blend. */
  private captureTransitionStart(): void {
    // Nothing has been rendered yet, so there is no pose to blend away from and
    // a "transition" would animate out of the origin.
    if (!this.posePublished) {
      this.transitionActive = false;
      return;
    }
    // A switch mid-transition restarts from wherever the blend currently is,
    // which is a real pose, so reversing a mode change never cuts either.
    this.writeCurrentPoseIfIdle();
    const anchorX = this.activeAnchorX();
    const anchorY = this.activeAnchorY();
    const anchorZ = this.activeAnchorZ();
    const offsetX = this.currentPose.positionKm.x - anchorX;
    const offsetY = this.currentPose.positionKm.y - anchorY;
    const offsetZ = this.currentPose.positionKm.z - anchorZ;
    const distanceKm = Math.hypot(offsetX, offsetY, offsetZ);
    this.transitionStartAnchorXKm = anchorX;
    this.transitionStartAnchorYKm = anchorY;
    this.transitionStartAnchorZKm = anchorZ;
    if (distanceKm > 0) {
      this.transitionStartDirectionX = offsetX / distanceKm;
      this.transitionStartDirectionY = offsetY / distanceKm;
      this.transitionStartDirectionZ = offsetZ / distanceKm;
      this.transitionStartDistanceKm = distanceKm;
    } else {
      this.transitionStartDirectionX = 0;
      this.transitionStartDirectionY = 0;
      this.transitionStartDirectionZ = 1;
      this.transitionStartDistanceKm = Number.MIN_VALUE;
    }
    this.transitionStartLookX = this.currentPose.lookDirection.x;
    this.transitionStartLookY = this.currentPose.lookDirection.y;
    this.transitionStartLookZ = this.currentPose.lookDirection.z;
    this.transitionStartUpX = this.currentPose.upDirection.x;
    this.transitionStartUpY = this.currentPose.upDirection.y;
    this.transitionStartUpZ = this.currentPose.upDirection.z;
    this.transitionStartFovDeg = this.currentPose.fovDeg;
    this.transitionElapsedSec = 0;
    this.transitionActive = true;
  }

  private writeCurrentPoseIfIdle(): void {
    if (!this.transitionActive) this.writeActiveModePose();
  }

  /** Point the active mode orbits: the ship in chase, the focus body otherwise. */
  private activeAnchorX(): number {
    return this.currentMode === 'chase'
      ? this.chase.subjectPositionKm.x
      : this.orbit.focusPositionKm.x;
  }

  private activeAnchorY(): number {
    return this.currentMode === 'chase'
      ? this.chase.subjectPositionKm.y
      : this.orbit.focusPositionKm.y;
  }

  private activeAnchorZ(): number {
    return this.currentMode === 'chase'
      ? this.chase.subjectPositionKm.z
      : this.orbit.focusPositionKm.z;
  }

  private writeBlendedPose(blend: number): void {
    const endAnchorX = this.activeAnchorX();
    const endAnchorY = this.activeAnchorY();
    const endAnchorZ = this.activeAnchorZ();
    const endOffsetX = this.endPoseX() - endAnchorX;
    const endOffsetY = this.endPoseY() - endAnchorY;
    const endOffsetZ = this.endPoseZ() - endAnchorZ;
    const endDistanceKm = Math.hypot(endOffsetX, endOffsetY, endOffsetZ);
    const safeEndDistanceKm = endDistanceKm > 0 ? endDistanceKm : Number.MIN_VALUE;

    slerpUnitDirectionInto(
      this.directionScratch,
      this.transitionStartDirectionX,
      this.transitionStartDirectionY,
      this.transitionStartDirectionZ,
      endDistanceKm > 0 ? endOffsetX / endDistanceKm : this.transitionStartDirectionX,
      endDistanceKm > 0 ? endOffsetY / endDistanceKm : this.transitionStartDirectionY,
      endDistanceKm > 0 ? endOffsetZ / endDistanceKm : this.transitionStartDirectionZ,
      blend,
    );
    const distanceKm = interpolateLogarithmic(
      this.transitionStartDistanceKm,
      safeEndDistanceKm,
      blend,
    );
    const anchorX =
      this.transitionStartAnchorXKm + (endAnchorX - this.transitionStartAnchorXKm) * blend;
    const anchorY =
      this.transitionStartAnchorYKm + (endAnchorY - this.transitionStartAnchorYKm) * blend;
    const anchorZ =
      this.transitionStartAnchorZKm + (endAnchorZ - this.transitionStartAnchorZKm) * blend;
    this.currentPose.positionKm.x = anchorX + (this.directionScratch[0] as number) * distanceKm;
    this.currentPose.positionKm.y = anchorY + (this.directionScratch[1] as number) * distanceKm;
    this.currentPose.positionKm.z = anchorZ + (this.directionScratch[2] as number) * distanceKm;

    slerpUnitDirectionInto(
      this.lookScratch,
      this.transitionStartLookX,
      this.transitionStartLookY,
      this.transitionStartLookZ,
      this.endLookX(),
      this.endLookY(),
      this.endLookZ(),
      blend,
    );
    this.currentPose.lookDirection.x = this.lookScratch[0] as number;
    this.currentPose.lookDirection.y = this.lookScratch[1] as number;
    this.currentPose.lookDirection.z = this.lookScratch[2] as number;

    slerpUnitDirectionInto(
      this.upScratch,
      this.transitionStartUpX,
      this.transitionStartUpY,
      this.transitionStartUpZ,
      this.endUpX(),
      this.endUpY(),
      this.endUpZ(),
      blend,
    );
    this.currentPose.upDirection.x = this.upScratch[0] as number;
    this.currentPose.upDirection.y = this.upScratch[1] as number;
    this.currentPose.upDirection.z = this.upScratch[2] as number;

    this.currentPose.fovDeg =
      this.transitionStartFovDeg + (this.endFovDeg() - this.transitionStartFovDeg) * blend;
  }

  private endPoseX(): number {
    return this.currentMode === 'chase'
      ? this.chase.cameraPositionKm.x
      : this.orbit.cameraPositionKm.x;
  }

  private endPoseY(): number {
    return this.currentMode === 'chase'
      ? this.chase.cameraPositionKm.y
      : this.orbit.cameraPositionKm.y;
  }

  private endPoseZ(): number {
    return this.currentMode === 'chase'
      ? this.chase.cameraPositionKm.z
      : this.orbit.cameraPositionKm.z;
  }

  private endLookX(): number {
    return this.currentMode === 'chase' ? this.chase.lookDirection.x : this.orbit.lookDirection.x;
  }

  private endLookY(): number {
    return this.currentMode === 'chase' ? this.chase.lookDirection.y : this.orbit.lookDirection.y;
  }

  private endLookZ(): number {
    return this.currentMode === 'chase' ? this.chase.lookDirection.z : this.orbit.lookDirection.z;
  }

  private endUpX(): number {
    if (this.currentMode === 'chase') return this.chase.upDirection.x;
    return this.currentMode === 'cinematic' ? this.cinematic.upDirection.x : 0;
  }

  private endUpY(): number {
    if (this.currentMode === 'chase') return this.chase.upDirection.y;
    return this.currentMode === 'cinematic' ? this.cinematic.upDirection.y : 1;
  }

  private endUpZ(): number {
    if (this.currentMode === 'chase') return this.chase.upDirection.z;
    return this.currentMode === 'cinematic' ? this.cinematic.upDirection.z : 0;
  }

  private endFovDeg(): number {
    if (this.currentMode === 'chase') return this.baseFovDeg + this.chase.fovOffsetDeg;
    return this.currentMode === 'cinematic' ? this.cinematic.fovDeg : this.baseFovDeg;
  }
}
