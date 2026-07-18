import type { ReadonlyVec3 } from '../core/vec3.js';
import {
  BufferAttribute,
  InterleavedBufferAttribute,
  PerspectiveCamera,
  Scene,
  type InstancedInterleavedBuffer,
  type Object3D,
  type Points,
  type Sphere,
} from 'three';
import type { Line2 } from 'three/addons/lines/Line2.js';

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

export interface PackedPolylineBinding {
  readonly maximumPointCount: number;
  readonly pointCount: number;
  setPointCount(pointCount: number): void;
}

class CameraRelativePackedPolylineBinding implements PackedPolylineBinding {
  readonly maximumPointCount: number;
  pointCount = 0;

  readonly boundingSphere: Sphere;
  readonly segmentBuffer: InstancedInterleavedBuffer;
  readonly segmentComponents: Float32Array;

  constructor(
    readonly line: Line2,
    readonly positionsKm: Float64Array,
  ) {
    this.maximumPointCount = positionsKm.length / 3;
    const startAttribute = line.geometry.getAttribute('instanceStart');
    if (
      !(startAttribute instanceof InterleavedBufferAttribute) ||
      !(startAttribute.data.array instanceof Float32Array) ||
      startAttribute.data.array.length < (this.maximumPointCount - 1) * 6
    ) {
      throw new RangeError('Line2 requires a maximum-sized float32 segment buffer.');
    }
    if (line.geometry.boundingSphere === null) {
      throw new RangeError('Line2 requires one reusable bounding sphere.');
    }
    this.segmentBuffer = startAttribute.data as InstancedInterleavedBuffer;
    this.segmentComponents = startAttribute.data.array;
    this.boundingSphere = line.geometry.boundingSphere;
    line.geometry.instanceCount = 0;
  }

  setPointCount(pointCount: number): void {
    if (
      !Number.isInteger(pointCount) ||
      pointCount < 0 ||
      pointCount > this.maximumPointCount ||
      pointCount === 1
    ) {
      throw new RangeError('Packed polyline point count must be zero or within [2, maximum].');
    }
    this.pointCount = pointCount;
    this.line.geometry.instanceCount = Math.max(0, pointCount - 1);
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
  private readonly packedPolylines: CameraRelativePackedPolylineBinding[] = [];
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

  /** Binds one preallocated Line2 to stable caller-owned float64 xyz points. */
  bindPackedPolyline(line: Line2, positionsKm: Float64Array): PackedPolylineBinding {
    assertPackedPositions(positionsKm);
    if (positionsKm.length < 6) {
      throw new RangeError('Packed polylines require at least two xyz points.');
    }
    const binding = new CameraRelativePackedPolylineBinding(line, positionsKm);
    this.claimVisual(line);
    this.packedPolylines.push(binding);
    return binding;
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
    const packedPolylineIndex = this.packedPolylines.findIndex(
      (binding) => binding.line === visual,
    );
    if (packedPolylineIndex >= 0) this.packedPolylines.splice(packedPolylineIndex, 1);
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

    for (let bindingIndex = 0; bindingIndex < this.packedPolylines.length; bindingIndex += 1) {
      const binding = this.packedPolylines[bindingIndex];
      if (binding === undefined) throw new Error('Packed polyline bindings are sparse.');
      const pointCount = binding.pointCount;
      if (pointCount === 0) continue;

      let minimumX = Number.POSITIVE_INFINITY;
      let minimumY = Number.POSITIVE_INFINITY;
      let minimumZ = Number.POSITIVE_INFINITY;
      let maximumX = Number.NEGATIVE_INFINITY;
      let maximumY = Number.NEGATIVE_INFINITY;
      let maximumZ = Number.NEGATIVE_INFINITY;
      for (let segmentIndex = 0; segmentIndex < pointCount - 1; segmentIndex += 1) {
        const startOffset = segmentIndex * 3;
        const endOffset = startOffset + 3;
        const segmentOffset = segmentIndex * 6;
        const startX = Math.fround(
          (binding.positionsKm[startOffset] as number) - cameraPositionKm.x,
        );
        const startY = Math.fround(
          (binding.positionsKm[startOffset + 1] as number) - cameraPositionKm.y,
        );
        const startZ = Math.fround(
          (binding.positionsKm[startOffset + 2] as number) - cameraPositionKm.z,
        );
        const endX = Math.fround((binding.positionsKm[endOffset] as number) - cameraPositionKm.x);
        const endY = Math.fround(
          (binding.positionsKm[endOffset + 1] as number) - cameraPositionKm.y,
        );
        const endZ = Math.fround(
          (binding.positionsKm[endOffset + 2] as number) - cameraPositionKm.z,
        );
        if (
          !Number.isFinite(startX) ||
          !Number.isFinite(startY) ||
          !Number.isFinite(startZ) ||
          !Number.isFinite(endX) ||
          !Number.isFinite(endY) ||
          !Number.isFinite(endZ)
        ) {
          throw new RangeError('Packed polyline positions must contain finite coordinates.');
        }
        binding.segmentComponents[segmentOffset] = startX;
        binding.segmentComponents[segmentOffset + 1] = startY;
        binding.segmentComponents[segmentOffset + 2] = startZ;
        binding.segmentComponents[segmentOffset + 3] = endX;
        binding.segmentComponents[segmentOffset + 4] = endY;
        binding.segmentComponents[segmentOffset + 5] = endZ;
        minimumX = Math.min(minimumX, startX, endX);
        minimumY = Math.min(minimumY, startY, endY);
        minimumZ = Math.min(minimumZ, startZ, endZ);
        maximumX = Math.max(maximumX, startX, endX);
        maximumY = Math.max(maximumY, startY, endY);
        maximumZ = Math.max(maximumZ, startZ, endZ);
      }
      const centerX = (minimumX + maximumX) * 0.5;
      const centerY = (minimumY + maximumY) * 0.5;
      const centerZ = (minimumZ + maximumZ) * 0.5;
      let maximumRadiusSquared = 0;
      for (let pointIndex = 0; pointIndex < pointCount; pointIndex += 1) {
        const pointOffset = pointIndex * 3;
        const x =
          Math.fround((binding.positionsKm[pointOffset] as number) - cameraPositionKm.x) - centerX;
        const y =
          Math.fround((binding.positionsKm[pointOffset + 1] as number) - cameraPositionKm.y) -
          centerY;
        const z =
          Math.fround((binding.positionsKm[pointOffset + 2] as number) - cameraPositionKm.z) -
          centerZ;
        maximumRadiusSquared = Math.max(maximumRadiusSquared, x * x + y * y + z * z);
      }
      binding.boundingSphere.center.set(centerX, centerY, centerZ);
      binding.boundingSphere.radius = Math.sqrt(maximumRadiusSquared);
      binding.segmentBuffer.needsUpdate = true;
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
