import type { ReadonlyVec3 } from '../core/vec3.js';

const DEFAULT_TRANSFER_DURATION_SEC = 1.5;
const MAX_DISTANCE_KM = 1e10;
const MIN_CLEARANCE_KM = 0.002;
const RELATIVE_CLEARANCE = 1e-6;
const DEFAULT_FRAME_RADIUS_MULTIPLIER = 3;
const TRANSFER_CONTEXT_RATIO = 0.15;
const WHEEL_EXPONENT_PER_DELTA = 0.0015;
const MAX_PITCH_RAD = Math.PI / 2 - 1e-4;
const TWO_PI = Math.PI * 2;

interface MutableVec3 {
  x: number;
  y: number;
  z: number;
}

export interface CameraFocusTarget {
  readonly id: string;
  readonly positionOffset: number;
  readonly meanRadiusKm: number;
}

export interface OrbitCameraControllerOptions {
  readonly positionsKm: Float64Array;
  readonly targets: readonly CameraFocusTarget[];
  readonly initialFocusId: string;
  readonly initialCameraPositionKm: ReadonlyVec3;
  readonly transferDurationSec?: number;
}

function assertFiniteVec3(label: string, value: ReadonlyVec3): void {
  if (!Number.isFinite(value.x) || !Number.isFinite(value.y) || !Number.isFinite(value.z)) {
    throw new RangeError(`${label} must contain finite coordinates.`);
  }
}

function smootherstep(value: number): number {
  return value * value * value * (value * (value * 6 - 15) + 10);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

/** Allocation-free float64 orbit camera state for camera-relative rendering. */
export class OrbitCameraController {
  readonly cameraPositionKm: MutableVec3 = { x: 0, y: 0, z: 0 };
  readonly focusPositionKm: MutableVec3 = { x: 0, y: 0, z: 0 };
  readonly lookDirection: MutableVec3 = { x: 0, y: 0, z: -1 };

  private readonly positionsKm: Float64Array;
  private readonly targets: readonly CameraFocusTarget[];
  private readonly transferDurationSec: number;
  private focusTargetIndex: number;
  private yawRad = 0;
  private pitchRad = 0;
  private currentDistanceKm = 0;
  private transitionActive = false;
  private transitionElapsedSec = 0;
  private transitionStartFocusX = 0;
  private transitionStartFocusY = 0;
  private transitionStartFocusZ = 0;
  private transitionStartDistanceKm = 0;
  private transitionEndDistanceKm = 0;
  private transitionStartMinimumDistanceKm = 0;
  private transitionEndMinimumDistanceKm = 0;
  private transitionTravelDistanceKm = 0;
  private transitionZoomFactor = 1;

  constructor(options: OrbitCameraControllerOptions) {
    if (options.targets.length === 0) throw new RangeError('Camera targets cannot be empty.');
    assertFiniteVec3('Initial camera position', options.initialCameraPositionKm);

    this.positionsKm = options.positionsKm;
    this.targets = options.targets;
    this.transferDurationSec = options.transferDurationSec ?? DEFAULT_TRANSFER_DURATION_SEC;
    if (!Number.isFinite(this.transferDurationSec) || this.transferDurationSec <= 0) {
      throw new RangeError('Camera transfer duration must be finite and positive.');
    }

    let initialTargetIndex = -1;
    for (let index = 0; index < this.targets.length; index += 1) {
      const target = this.targets[index];
      if (target === undefined) throw new Error('Camera target array is sparse.');
      if (target.id.length === 0) throw new Error('Camera target id cannot be empty.');
      if (
        !Number.isInteger(target.positionOffset) ||
        target.positionOffset < 0 ||
        target.positionOffset % 3 !== 0 ||
        target.positionOffset + 2 >= this.positionsKm.length
      ) {
        throw new RangeError(`Camera target "${target.id}" has an invalid position offset.`);
      }
      if (!Number.isFinite(target.meanRadiusKm) || target.meanRadiusKm <= 0) {
        throw new RangeError(`Camera target "${target.id}" must have a positive finite radius.`);
      }
      for (let previousIndex = 0; previousIndex < index; previousIndex += 1) {
        if (this.targets[previousIndex]?.id === target.id) {
          throw new Error(`Duplicate camera target id "${target.id}".`);
        }
      }
      if (target.id === options.initialFocusId) initialTargetIndex = index;
    }
    if (initialTargetIndex < 0) {
      throw new Error(`Unknown initial camera focus "${options.initialFocusId}".`);
    }
    this.focusTargetIndex = initialTargetIndex;
    this.readTargetPositionIntoFocus();

    const offsetX = options.initialCameraPositionKm.x - this.focusPositionKm.x;
    const offsetY = options.initialCameraPositionKm.y - this.focusPositionKm.y;
    const offsetZ = options.initialCameraPositionKm.z - this.focusPositionKm.z;
    const distanceKm = Math.hypot(offsetX, offsetY, offsetZ);
    if (!Number.isFinite(distanceKm) || distanceKm <= 0) {
      throw new RangeError('Initial camera must be separated from its focus target.');
    }
    this.currentDistanceKm = clamp(
      distanceKm,
      this.minimumDistanceForTarget(initialTargetIndex),
      MAX_DISTANCE_KM,
    );
    this.yawRad = Math.atan2(offsetY, offsetX);
    this.pitchRad = clamp(Math.asin(offsetZ / distanceKm), -MAX_PITCH_RAD, MAX_PITCH_RAD);
    this.recomputeCamera();
  }

  get focusId(): string {
    const target = this.targets[this.focusTargetIndex];
    if (target === undefined) throw new Error('Active camera target is missing.');
    return target.id;
  }

  get distanceKm(): number {
    return this.currentDistanceKm;
  }

  get isTransitioning(): boolean {
    return this.transitionActive;
  }

  orbitBy(deltaYawRad: number, deltaPitchRad: number): void {
    if (!Number.isFinite(deltaYawRad) || !Number.isFinite(deltaPitchRad)) {
      throw new RangeError('Camera orbit deltas must be finite.');
    }
    this.yawRad = (this.yawRad + deltaYawRad) % TWO_PI;
    this.pitchRad = clamp(this.pitchRad + deltaPitchRad, -MAX_PITCH_RAD, MAX_PITCH_RAD);
    this.recomputeCamera();
  }

  zoomByWheel(wheelDelta: number): void {
    if (!Number.isFinite(wheelDelta)) throw new RangeError('Camera wheel delta must be finite.');
    const scale = Math.exp(wheelDelta * WHEEL_EXPONENT_PER_DELTA);
    const minimumDistanceKm = this.transitionActive
      ? this.transitionMinimumDistanceAtCurrentTime()
      : this.minimumDistanceForTarget(this.focusTargetIndex);
    const nextDistanceKm = clamp(
      this.currentDistanceKm * scale,
      minimumDistanceKm,
      MAX_DISTANCE_KM,
    );
    if (this.transitionActive && this.currentDistanceKm > 0) {
      this.transitionZoomFactor *= nextDistanceKm / this.currentDistanceKm;
    }
    this.currentDistanceKm = nextDistanceKm;
    this.recomputeCamera();
  }

  focusBody(id: string): boolean {
    let nextIndex = -1;
    for (let index = 0; index < this.targets.length; index += 1) {
      if (this.targets[index]?.id === id) {
        nextIndex = index;
        break;
      }
    }
    if (nextIndex < 0 || nextIndex === this.focusTargetIndex) return false;

    const offset = this.targets[nextIndex]?.positionOffset;
    if (offset === undefined) throw new Error('Requested camera target is missing.');
    const targetX = this.positionsKm[offset];
    const targetY = this.positionsKm[offset + 1];
    const targetZ = this.positionsKm[offset + 2];
    if (targetX === undefined || targetY === undefined || targetZ === undefined) {
      throw new Error('Requested camera target position is missing.');
    }
    if (!Number.isFinite(targetX) || !Number.isFinite(targetY) || !Number.isFinite(targetZ)) {
      throw new RangeError('Requested camera target position must be finite.');
    }

    const startMinimumDistanceKm = this.transitionActive
      ? this.transitionMinimumDistanceAtCurrentTime()
      : this.minimumDistanceForTarget(this.focusTargetIndex);
    this.transitionStartFocusX = this.focusPositionKm.x;
    this.transitionStartFocusY = this.focusPositionKm.y;
    this.transitionStartFocusZ = this.focusPositionKm.z;
    this.transitionStartDistanceKm = this.currentDistanceKm;
    const targetRadiusKm = this.targets[nextIndex]?.meanRadiusKm;
    if (targetRadiusKm === undefined) throw new Error('Requested camera target radius is missing.');
    const endMinimumDistanceKm = this.minimumDistanceForTarget(nextIndex);
    this.transitionStartMinimumDistanceKm = startMinimumDistanceKm;
    this.transitionEndMinimumDistanceKm = endMinimumDistanceKm;
    this.transitionEndDistanceKm = Math.max(
      endMinimumDistanceKm,
      targetRadiusKm * DEFAULT_FRAME_RADIUS_MULTIPLIER,
    );
    const travelX = targetX - this.transitionStartFocusX;
    const travelY = targetY - this.transitionStartFocusY;
    const travelZ = targetZ - this.transitionStartFocusZ;
    this.transitionTravelDistanceKm = Math.hypot(travelX, travelY, travelZ);
    this.transitionZoomFactor = 1;
    this.transitionElapsedSec = 0;
    this.transitionActive = true;
    this.focusTargetIndex = nextIndex;
    return true;
  }

  cycleFocus(step: number): string {
    if (!Number.isInteger(step) || step === 0) {
      throw new RangeError('Camera focus cycle step must be a nonzero integer.');
    }
    const targetCount = this.targets.length;
    const nextIndex = (((this.focusTargetIndex + step) % targetCount) + targetCount) % targetCount;
    const nextTarget = this.targets[nextIndex];
    if (nextTarget === undefined) throw new Error('Cycled camera target is missing.');
    this.focusBody(nextTarget.id);
    return nextTarget.id;
  }

  update(deltaSec: number): void {
    if (!Number.isFinite(deltaSec) || deltaSec < 0) {
      throw new RangeError('Camera update delta must be finite and nonnegative.');
    }
    if (!this.transitionActive) {
      this.readTargetPositionIntoFocus();
      this.recomputeCamera();
      return;
    }
    if (deltaSec === 0) return;

    this.transitionElapsedSec = Math.min(
      this.transferDurationSec,
      this.transitionElapsedSec + deltaSec,
    );
    if (
      this.transferDurationSec - this.transitionElapsedSec <=
      Number.EPSILON * this.transferDurationSec * 16
    ) {
      this.transitionElapsedSec = this.transferDurationSec;
    }
    const time = this.transitionElapsedSec / this.transferDurationSec;
    if (time >= 1) {
      this.readTargetPositionIntoFocus();
      this.currentDistanceKm = clamp(
        this.transitionEndDistanceKm * this.transitionZoomFactor,
        this.transitionEndMinimumDistanceKm,
        MAX_DISTANCE_KM,
      );
      this.transitionActive = false;
      this.transitionZoomFactor = 1;
      this.recomputeCamera();
      return;
    }

    const offset = this.targets[this.focusTargetIndex]?.positionOffset;
    if (offset === undefined) throw new Error('Active camera target position is missing.');
    const targetX = this.positionsKm[offset];
    const targetY = this.positionsKm[offset + 1];
    const targetZ = this.positionsKm[offset + 2];
    if (targetX === undefined || targetY === undefined || targetZ === undefined) {
      throw new Error('Active camera target position is incomplete.');
    }
    if (!Number.isFinite(targetX) || !Number.isFinite(targetY) || !Number.isFinite(targetZ)) {
      throw new RangeError('Active camera target position must be finite.');
    }
    const blend = smootherstep(time);
    this.focusPositionKm.x =
      this.transitionStartFocusX + (targetX - this.transitionStartFocusX) * blend;
    this.focusPositionKm.y =
      this.transitionStartFocusY + (targetY - this.transitionStartFocusY) * blend;
    this.focusPositionKm.z =
      this.transitionStartFocusZ + (targetZ - this.transitionStartFocusZ) * blend;

    const logarithmicDistanceKm = Math.exp(
      Math.log(this.transitionStartDistanceKm) +
        (Math.log(this.transitionEndDistanceKm) - Math.log(this.transitionStartDistanceKm)) * blend,
    );
    const envelope = Math.sin(Math.PI * time);
    this.currentDistanceKm = clamp(
      (logarithmicDistanceKm +
        this.transitionTravelDistanceKm * TRANSFER_CONTEXT_RATIO * envelope * envelope) *
        this.transitionZoomFactor,
      this.transitionMinimumDistanceAtBlend(blend),
      MAX_DISTANCE_KM,
    );
    this.recomputeCamera();
  }

  private minimumDistanceForTarget(index: number): number {
    const radiusKm = this.targets[index]?.meanRadiusKm;
    if (radiusKm === undefined) throw new Error('Camera target radius is missing.');
    return radiusKm + Math.max(MIN_CLEARANCE_KM, radiusKm * RELATIVE_CLEARANCE);
  }

  private transitionMinimumDistanceAtCurrentTime(): number {
    const time = this.transitionElapsedSec / this.transferDurationSec;
    return this.transitionMinimumDistanceAtBlend(smootherstep(time));
  }

  private transitionMinimumDistanceAtBlend(blend: number): number {
    return (
      this.transitionStartMinimumDistanceKm +
      (this.transitionEndMinimumDistanceKm - this.transitionStartMinimumDistanceKm) * blend
    );
  }

  private readTargetPositionIntoFocus(): void {
    const offset = this.targets[this.focusTargetIndex]?.positionOffset;
    if (offset === undefined) throw new Error('Active camera target position is missing.');
    const x = this.positionsKm[offset];
    const y = this.positionsKm[offset + 1];
    const z = this.positionsKm[offset + 2];
    if (x === undefined || y === undefined || z === undefined) {
      throw new Error('Active camera target position is incomplete.');
    }
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      throw new RangeError('Active camera target position must be finite.');
    }
    this.focusPositionKm.x = x;
    this.focusPositionKm.y = y;
    this.focusPositionKm.z = z;
  }

  private recomputeCamera(): void {
    const cosPitch = Math.cos(this.pitchRad);
    const unitX = cosPitch * Math.cos(this.yawRad);
    const unitY = cosPitch * Math.sin(this.yawRad);
    const unitZ = Math.sin(this.pitchRad);
    this.cameraPositionKm.x = this.focusPositionKm.x + unitX * this.currentDistanceKm;
    this.cameraPositionKm.y = this.focusPositionKm.y + unitY * this.currentDistanceKm;
    this.cameraPositionKm.z = this.focusPositionKm.z + unitZ * this.currentDistanceKm;
    this.lookDirection.x = -unitX;
    this.lookDirection.y = -unitY;
    this.lookDirection.z = -unitZ;
  }
}
