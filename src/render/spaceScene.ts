import type { ReadonlyVec3 } from '../core/vec3.js';
import { BufferAttribute, PerspectiveCamera, Scene, type Object3D, type Points } from 'three';

export const SPACE_NEAR_KM = 0.001;
export const SPACE_FAR_KM = 1e10;

function assertFinitePosition(label: string, positionKm: ReadonlyVec3): void {
  if (
    !Number.isFinite(positionKm.x) ||
    !Number.isFinite(positionKm.y) ||
    !Number.isFinite(positionKm.z)
  ) {
    throw new RangeError(`${label} must contain finite kilometre coordinates.`);
  }
}

function assertPackedPositions(positionsKm: Float64Array): void {
  if (positionsKm.length === 0 || positionsKm.length % 3 !== 0) {
    throw new RangeError('Packed positions must contain one or more xyz triples.');
  }
  for (let index = 0; index < positionsKm.length; index += 1) {
    if (!Number.isFinite(positionsKm[index])) {
      throw new RangeError('Packed positions must contain finite kilometre coordinates.');
    }
  }
}

/**
 * Owns the single float64-to-render-coordinate boundary for space visuals.
 * Physics positions remain in caller-owned objects and are never accumulated
 * through the lower-precision render representation.
 */
export class CameraRelativeSpaceScene {
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(75, 1, SPACE_NEAR_KM, SPACE_FAR_KM);

  private readonly visuals: Object3D[] = [];
  private readonly positionsKm: ReadonlyVec3[] = [];
  private readonly packedVisuals: Object3D[] = [];
  private readonly packedVisualPositionsKm: Float64Array[] = [];
  private readonly packedVisualOffsets: number[] = [];
  private readonly packedPointVisuals: Points[] = [];
  private readonly packedPointPositionsKm: Float64Array[] = [];
  private readonly packedPointAttributes: BufferAttribute[] = [];
  private readonly boundVisuals = new Set<Object3D>();

  constructor() {
    this.camera.position.set(0, 0, 0);
    this.camera.matrixAutoUpdate = false;
    this.camera.updateMatrix();
  }

  /** Binds a setup-time visual to a caller-owned float64 physics position. */
  bindVisual(visual: Object3D, positionKm: ReadonlyVec3): void {
    assertFinitePosition('visual position', positionKm);
    this.claimVisual(visual);
    this.visuals.push(visual);
    this.positionsKm.push(positionKm);
  }

  /** Binds one visual root to an xyz triple in a caller-owned packed array. */
  bindPackedVisual(visual: Object3D, positionsKm: Float64Array, componentOffset: number): void {
    assertPackedPositions(positionsKm);
    if (
      !Number.isInteger(componentOffset) ||
      componentOffset < 0 ||
      componentOffset % 3 !== 0 ||
      componentOffset + 2 >= positionsKm.length
    ) {
      throw new RangeError('Packed visual offset must address one complete xyz triple.');
    }

    this.claimVisual(visual);
    this.packedVisuals.push(visual);
    this.packedVisualPositionsKm.push(positionsKm);
    this.packedVisualOffsets.push(componentOffset);
  }

  /** Binds a Points position attribute to all xyz triples in one packed array. */
  bindPackedPointPositions(points: Points, positionsKm: Float64Array): void {
    assertPackedPositions(positionsKm);
    const attribute = points.geometry.getAttribute('position');
    if (
      !(attribute instanceof BufferAttribute) ||
      !(attribute.array instanceof Float32Array) ||
      attribute.itemSize !== 3 ||
      attribute.array.length !== positionsKm.length
    ) {
      throw new RangeError('Points require a same-length float32 xyz position attribute.');
    }

    this.claimVisual(points);
    this.packedPointVisuals.push(points);
    this.packedPointPositionsKm.push(positionsKm);
    this.packedPointAttributes.push(attribute);
  }

  /** Releases one setup-time binding and removes its visual from the scene. */
  unbindVisual(visual: Object3D): boolean {
    if (!this.boundVisuals.delete(visual)) return false;

    const visualIndex = this.visuals.indexOf(visual);
    if (visualIndex >= 0) {
      this.visuals.splice(visualIndex, 1);
      this.positionsKm.splice(visualIndex, 1);
    }
    const packedVisualIndex = this.packedVisuals.indexOf(visual);
    if (packedVisualIndex >= 0) {
      this.packedVisuals.splice(packedVisualIndex, 1);
      this.packedVisualPositionsKm.splice(packedVisualIndex, 1);
      this.packedVisualOffsets.splice(packedVisualIndex, 1);
    }
    const packedPointIndex = this.packedPointVisuals.indexOf(visual as Points);
    if (packedPointIndex >= 0) {
      this.packedPointVisuals.splice(packedPointIndex, 1);
      this.packedPointPositionsKm.splice(packedPointIndex, 1);
      this.packedPointAttributes.splice(packedPointIndex, 1);
    }
    this.scene.remove(visual);
    return true;
  }

  /** Recomputes render coordinates from float64 inputs without frame allocations. */
  updateCameraRelative(cameraPositionKm: ReadonlyVec3): void {
    assertFinitePosition('camera position', cameraPositionKm);

    for (let index = 0; index < this.visuals.length; index += 1) {
      const visual = this.visuals[index];
      const positionKm = this.positionsKm[index];

      if (visual === undefined || positionKm === undefined) {
        throw new Error('Space scene binding arrays are out of sync.');
      }

      assertFinitePosition('visual position', positionKm);

      visual.position.set(
        Math.fround(positionKm.x - cameraPositionKm.x),
        Math.fround(positionKm.y - cameraPositionKm.y),
        Math.fround(positionKm.z - cameraPositionKm.z),
      );
      visual.updateMatrix();
    }

    for (let index = 0; index < this.packedVisuals.length; index += 1) {
      const visual = this.packedVisuals[index];
      const positionsKm = this.packedVisualPositionsKm[index];
      const offset = this.packedVisualOffsets[index];
      if (visual === undefined || positionsKm === undefined || offset === undefined) {
        throw new Error('Packed visual binding arrays are out of sync.');
      }

      const x = positionsKm[offset] ?? Number.NaN;
      const y = positionsKm[offset + 1] ?? Number.NaN;
      const z = positionsKm[offset + 2] ?? Number.NaN;
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        throw new RangeError('Packed visual position must contain finite coordinates.');
      }
      visual.position.set(
        Math.fround(x - cameraPositionKm.x),
        Math.fround(y - cameraPositionKm.y),
        Math.fround(z - cameraPositionKm.z),
      );
      visual.updateMatrix();
    }

    for (
      let bindingIndex = 0;
      bindingIndex < this.packedPointAttributes.length;
      bindingIndex += 1
    ) {
      const positionsKm = this.packedPointPositionsKm[bindingIndex];
      const attribute = this.packedPointAttributes[bindingIndex];
      if (positionsKm === undefined || attribute === undefined) {
        throw new Error('Packed point binding arrays are out of sync.');
      }
      const target = attribute.array as Float32Array;
      for (let component = 0; component < positionsKm.length; component += 3) {
        const x = positionsKm[component] ?? Number.NaN;
        const y = positionsKm[component + 1] ?? Number.NaN;
        const z = positionsKm[component + 2] ?? Number.NaN;
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
          throw new RangeError('Packed point positions must contain finite coordinates.');
        }
        target[component] = Math.fround(x - cameraPositionKm.x);
        target[component + 1] = Math.fround(y - cameraPositionKm.y);
        target[component + 2] = Math.fround(z - cameraPositionKm.z);
      }
      attribute.needsUpdate = true;
    }
  }

  private claimVisual(visual: Object3D): void {
    if (this.boundVisuals.has(visual)) {
      throw new Error('Visual is already bound to this space scene.');
    }

    this.boundVisuals.add(visual);
    visual.matrixAutoUpdate = false;
    visual.updateMatrix();
    this.scene.add(visual);
  }
}
