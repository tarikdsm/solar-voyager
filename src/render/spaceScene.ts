import type { ReadonlyVec3 } from '../core/vec3.js';
import {
  BufferAttribute,
  type BufferGeometry,
  InterleavedBufferAttribute,
  PerspectiveCamera,
  Scene,
  type InstancedInterleavedBuffer,
  type Object3D,
  type Points,
  type Sphere,
} from 'three';
import type { Line2 } from 'three/addons/lines/Line2.js';

import {
  createEffectBindingDegradeState,
  createEffectBindingTelemetry,
  degradeEffectBinding,
  restoreEffectBinding,
  type EffectBindingDegradeState,
  type EffectBindingTelemetry,
  type EffectBindingWarner,
} from './effectBindingGuard.js';
import {
  writeAberratedPositionInto,
  type RelativisticVisualState,
} from './relativisticVisualState.js';

export const SPACE_NEAR_KM = 0.001;
/**
 * Far plane, kilometres — the whole catalog, not the inner system.
 *
 * Eris reaches 1.4617e10 km at aphelion, so the previous 1e10 km plane clipped
 * the outermost dwarf on every frame (T0129). 2.5e10 km clears it with 71 %
 * headroom. The raise is affordable because it costs `ln(2.5e10)/ln(1e10)` —
 * 4.0 % — of logarithmic depth resolution and essentially nothing under
 * reversed depth, whose precision is `2^-24 * L * (1 - L/far)` and therefore
 * far-plane-independent at any range worth rendering. Derivation, measured
 * floors and the rejected alternatives:
 * `docs/superpowers/specs/2026-08-16-far-plane-strategy-design.md` §1.
 * `src/render/spaceScene.test.ts` re-derives the catalog bound from
 * `data/bodies.json`, so a new outer body fails there rather than in a
 * screenshot nobody takes.
 */
export const SPACE_FAR_KM = 2.5e10;

export interface CameraRelativeSpaceSceneOptions {
  readonly farKm?: number;
  /**
   * Sink for the one-time effect-binding degrade warning; defaults to
   * `console.warn`. Injectable so a unit test can observe the warning without
   * reaching into the console.
   */
  readonly onEffectBindingWarning?: EffectBindingWarner;
}

function defaultEffectBindingWarning(message: string): void {
  console.warn(message);
}

function assertFinitePosition(label: string, positionKm: ReadonlyVec3): void {
  if (
    !Number.isFinite(positionKm.x) ||
    !Number.isFinite(positionKm.y) ||
    !Number.isFinite(positionKm.z)
  ) {
    throw new RangeError(`${label} must contain finite kilometre coordinates.`);
  }
}

/** Shape only: triple alignment, which is a programming error either way. */
function assertPackedPositionShape(positionsKm: Float64Array): void {
  if (positionsKm.length === 0 || positionsKm.length % 3 !== 0) {
    throw new RangeError('Packed positions must contain one or more xyz triples.');
  }
}

function assertPackedTripleOffset(positionsKm: Float64Array, componentOffset: number): void {
  if (
    !Number.isInteger(componentOffset) ||
    componentOffset < 0 ||
    componentOffset % 3 !== 0 ||
    componentOffset + 2 >= positionsKm.length
  ) {
    throw new RangeError('Packed visual offset must address one complete xyz triple.');
  }
}

function assertPackedPositions(positionsKm: Float64Array): void {
  assertPackedPositionShape(positionsKm);
  for (let index = 0; index < positionsKm.length; index += 1) {
    if (!Number.isFinite(positionsKm[index])) {
      throw new RangeError('Packed positions must contain finite kilometre coordinates.');
    }
  }
}

/**
 * One effect-only binding: the quiet half of the T0129 guard-policy split.
 *
 * Exactly one of `positionKm` / `packedPositionsKm` is set, so the update loop
 * reads both source shapes without a second pass over the scene.
 */
interface EffectVisualBinding {
  readonly visual: Object3D;
  readonly positionKm: ReadonlyVec3 | null;
  readonly packedPositionsKm: Float64Array | null;
  readonly componentOffset: number;
  readonly degradeState: EffectBindingDegradeState;
}

export interface PackedPolylineBinding {
  readonly maximumPointCount: number;
  readonly pointCount: number;
  setPointCount(pointCount: number): void;
}

type PackedPositionVisual = Object3D & { readonly geometry: BufferGeometry };

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
  readonly camera: PerspectiveCamera;

  private readonly visuals: Object3D[] = [];
  private readonly positionsKm: ReadonlyVec3[] = [];
  private readonly packedVisuals: Object3D[] = [];
  private readonly packedVisualPositionsKm: Float64Array[] = [];
  private readonly packedVisualOffsets: number[] = [];
  private readonly packedPositionVisuals: PackedPositionVisual[] = [];
  private readonly packedPositionsKm: Float64Array[] = [];
  private readonly packedPositionAttributes: BufferAttribute[] = [];
  private readonly packedPointVisuals: Points[] = [];
  private readonly packedPointPositionsKm: Float64Array[] = [];
  private readonly packedPointAttributes: BufferAttribute[] = [];
  private readonly packedPolylines: CameraRelativePackedPolylineBinding[] = [];
  private readonly effectVisuals: EffectVisualBinding[] = [];
  private readonly boundVisuals = new Set<Object3D>();
  private readonly aberratedPosition = new Float64Array(3);
  private readonly warnEffectBinding: EffectBindingWarner;
  private relativisticObserver: Readonly<RelativisticVisualState> | null = null;

  /**
   * The T0129 telemetry flag: one object, allocated here, mutated in place.
   *
   * Read `nonFiniteObserved` to answer "did any effect visual ever go NaN in
   * this session"; `degradedBindingCount` for what is degraded right now.
   */
  readonly effectBindingTelemetry: EffectBindingTelemetry = createEffectBindingTelemetry();

  constructor(options: CameraRelativeSpaceSceneOptions = {}) {
    const farKm = options.farKm ?? SPACE_FAR_KM;
    if (!Number.isFinite(farKm) || farKm <= SPACE_NEAR_KM) {
      throw new RangeError('Camera-relative far plane must exceed the finite near plane.');
    }
    this.warnEffectBinding = options.onEffectBindingWarning ?? defaultEffectBindingWarning;
    this.camera = new PerspectiveCamera(75, 1, SPACE_NEAR_KM, farKm);
    this.camera.position.set(0, 0, 0);
    this.camera.matrixAutoUpdate = false;
    this.camera.updateMatrix();
  }

  setRelativisticObserver(state: Readonly<RelativisticVisualState>): void {
    this.relativisticObserver = state;
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
    assertPackedTripleOffset(positionsKm, componentOffset);

    this.claimVisual(visual);
    this.packedVisuals.push(visual);
    this.packedVisualPositionsKm.push(positionsKm);
    this.packedVisualOffsets.push(componentOffset);
  }

  /**
   * Binds an effect-only visual, which degrades instead of throwing (T0129).
   *
   * Use this for plume, RCS, in-world markers and sky panorama roots — anything
   * whose position is a *derived* quantity. A non-finite source skips this
   * binding's write for the frame (the visual holds its last good position),
   * warns once, and raises {@link effectBindingTelemetry}. Ship and body
   * positions must keep using {@link bindVisual}/{@link bindPackedVisual},
   * which still throw: a NaN there is a physics bug.
   *
   * Source values are not checked at bind time — the first
   * {@link updateCameraRelative} routes them through the same degrade path, so
   * there is exactly one policy and a binding that starts bad can recover.
   */
  bindEffectVisual(visual: Object3D, positionKm: ReadonlyVec3, label: string): void {
    const degradeState = createEffectBindingDegradeState(label);
    this.claimVisual(visual);
    this.effectVisuals.push({
      visual,
      positionKm,
      packedPositionsKm: null,
      componentOffset: 0,
      degradeState,
    });
  }

  /** {@link bindEffectVisual} against one xyz triple of a packed array. */
  bindPackedEffectVisual(
    visual: Object3D,
    positionsKm: Float64Array,
    componentOffset: number,
    label: string,
  ): void {
    assertPackedPositionShape(positionsKm);
    assertPackedTripleOffset(positionsKm, componentOffset);
    const degradeState = createEffectBindingDegradeState(label);
    this.claimVisual(visual);
    this.effectVisuals.push({
      visual,
      positionKm: null,
      packedPositionsKm: positionsKm,
      componentOffset,
      degradeState,
    });
  }

  /** Binds a geometry position attribute to all xyz triples in one packed array. */
  bindPackedPositions(visual: PackedPositionVisual, positionsKm: Float64Array): void {
    assertPackedPositions(positionsKm);
    const attribute = visual.geometry.getAttribute('position');
    if (
      !(attribute instanceof BufferAttribute) ||
      !(attribute.array instanceof Float32Array) ||
      attribute.itemSize !== 3 ||
      attribute.array.length !== positionsKm.length
    ) {
      throw new RangeError('Visual requires a same-length float32 xyz position attribute.');
    }
    if (visual.frustumCulled && visual.geometry.boundingSphere === null) {
      visual.geometry.computeBoundingSphere();
    }

    this.claimVisual(visual);
    this.packedPositionVisuals.push(visual);
    this.packedPositionsKm.push(positionsKm);
    this.packedPositionAttributes.push(attribute);
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
    if (points.frustumCulled && points.geometry.boundingSphere === null) {
      points.geometry.computeBoundingSphere();
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
    const packedPositionIndex = this.packedPositionVisuals.indexOf(visual as PackedPositionVisual);
    if (packedPositionIndex >= 0) {
      this.packedPositionVisuals.splice(packedPositionIndex, 1);
      this.packedPositionsKm.splice(packedPositionIndex, 1);
      this.packedPositionAttributes.splice(packedPositionIndex, 1);
    }
    const packedPolylineIndex = this.packedPolylines.findIndex(
      (binding) => binding.line === visual,
    );
    if (packedPolylineIndex >= 0) this.packedPolylines.splice(packedPolylineIndex, 1);
    const effectIndex = this.effectVisuals.findIndex((binding) => binding.visual === visual);
    if (effectIndex >= 0) {
      const binding = this.effectVisuals[effectIndex];
      // A degraded effect that is removed is no longer degraded; the monotonic
      // evidence (`nonFiniteObserved`, `skippedBindCount`) survives on purpose.
      if (binding !== undefined)
        restoreEffectBinding(this.effectBindingTelemetry, binding.degradeState);
      this.effectVisuals.splice(effectIndex, 1);
    }
    this.scene.remove(visual);
    return true;
  }

  /** Recomputes render coordinates from float64 inputs without frame allocations. */
  updateCameraRelative(cameraPositionKm: ReadonlyVec3): void {
    assertFinitePosition('camera position', cameraPositionKm);
    const observer = this.relativisticObserver;
    const aberrationActive = observer !== null && observer.activation !== 0;

    for (let index = 0; index < this.visuals.length; index += 1) {
      const visual = this.visuals[index];
      const positionKm = this.positionsKm[index];

      if (visual === undefined || positionKm === undefined) {
        throw new Error('Space scene binding arrays are out of sync.');
      }

      assertFinitePosition('visual position', positionKm);

      const relativeX = positionKm.x - cameraPositionKm.x;
      const relativeY = positionKm.y - cameraPositionKm.y;
      const relativeZ = positionKm.z - cameraPositionKm.z;
      if (aberrationActive) {
        writeAberratedPositionInto(
          this.aberratedPosition,
          relativeX,
          relativeY,
          relativeZ,
          observer,
        );
        visual.position.set(
          Math.fround(this.aberratedPosition[0] as number),
          Math.fround(this.aberratedPosition[1] as number),
          Math.fround(this.aberratedPosition[2] as number),
        );
      } else {
        visual.position.set(Math.fround(relativeX), Math.fround(relativeY), Math.fround(relativeZ));
      }
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
      const relativeX = x - cameraPositionKm.x;
      const relativeY = y - cameraPositionKm.y;
      const relativeZ = z - cameraPositionKm.z;
      if (aberrationActive) {
        writeAberratedPositionInto(
          this.aberratedPosition,
          relativeX,
          relativeY,
          relativeZ,
          observer,
        );
        visual.position.set(
          Math.fround(this.aberratedPosition[0] as number),
          Math.fround(this.aberratedPosition[1] as number),
          Math.fround(this.aberratedPosition[2] as number),
        );
      } else {
        visual.position.set(Math.fround(relativeX), Math.fround(relativeY), Math.fround(relativeZ));
      }
      visual.updateMatrix();
    }

    // T0129 — effect-only visuals. Same float64 subtraction and the same single
    // `Math.fround` bridge as every other binding; the only difference is what
    // happens on a non-finite value. The output is checked as well as the input,
    // because an aberration transform is exactly where a finite source can still
    // produce a NaN, and skipping the write is the whole point of this path.
    for (let index = 0; index < this.effectVisuals.length; index += 1) {
      const binding = this.effectVisuals[index];
      if (binding === undefined) throw new Error('Effect visual bindings are sparse.');
      const packedPositionsKm = binding.packedPositionsKm;
      let sourceX: number;
      let sourceY: number;
      let sourceZ: number;
      if (packedPositionsKm === null) {
        const positionKm = binding.positionKm;
        if (positionKm === null) throw new Error('Effect visual binding has no position source.');
        sourceX = positionKm.x;
        sourceY = positionKm.y;
        sourceZ = positionKm.z;
      } else {
        const offset = binding.componentOffset;
        sourceX = packedPositionsKm[offset] ?? Number.NaN;
        sourceY = packedPositionsKm[offset + 1] ?? Number.NaN;
        sourceZ = packedPositionsKm[offset + 2] ?? Number.NaN;
      }
      const relativeX = sourceX - cameraPositionKm.x;
      const relativeY = sourceY - cameraPositionKm.y;
      const relativeZ = sourceZ - cameraPositionKm.z;
      let renderX: number;
      let renderY: number;
      let renderZ: number;
      if (aberrationActive) {
        writeAberratedPositionInto(
          this.aberratedPosition,
          relativeX,
          relativeY,
          relativeZ,
          observer,
        );
        renderX = Math.fround(this.aberratedPosition[0] as number);
        renderY = Math.fround(this.aberratedPosition[1] as number);
        renderZ = Math.fround(this.aberratedPosition[2] as number);
      } else {
        renderX = Math.fround(relativeX);
        renderY = Math.fround(relativeY);
        renderZ = Math.fround(relativeZ);
      }
      if (!Number.isFinite(renderX) || !Number.isFinite(renderY) || !Number.isFinite(renderZ)) {
        degradeEffectBinding(
          this.effectBindingTelemetry,
          binding.degradeState,
          this.warnEffectBinding,
        );
        continue;
      }
      restoreEffectBinding(this.effectBindingTelemetry, binding.degradeState);
      binding.visual.position.set(renderX, renderY, renderZ);
      binding.visual.updateMatrix();
    }

    for (
      let bindingIndex = 0;
      bindingIndex < this.packedPositionVisuals.length;
      bindingIndex += 1
    ) {
      const visual = this.packedPositionVisuals[bindingIndex];
      const positionsKm = this.packedPositionsKm[bindingIndex];
      const attribute = this.packedPositionAttributes[bindingIndex];
      if (visual === undefined || positionsKm === undefined || attribute === undefined) {
        throw new Error('Packed position binding arrays are out of sync.');
      }
      const target = attribute.array as Float32Array;
      let minimumX = Number.POSITIVE_INFINITY;
      let minimumY = Number.POSITIVE_INFINITY;
      let minimumZ = Number.POSITIVE_INFINITY;
      let maximumX = Number.NEGATIVE_INFINITY;
      let maximumY = Number.NEGATIVE_INFINITY;
      let maximumZ = Number.NEGATIVE_INFINITY;
      for (let component = 0; component < positionsKm.length; component += 3) {
        const x = positionsKm[component] ?? Number.NaN;
        const y = positionsKm[component + 1] ?? Number.NaN;
        const z = positionsKm[component + 2] ?? Number.NaN;
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
          throw new RangeError('Packed positions must contain finite coordinates.');
        }
        const relativeX = x - cameraPositionKm.x;
        const relativeY = y - cameraPositionKm.y;
        const relativeZ = z - cameraPositionKm.z;
        let renderX: number;
        let renderY: number;
        let renderZ: number;
        if (aberrationActive) {
          writeAberratedPositionInto(
            this.aberratedPosition,
            relativeX,
            relativeY,
            relativeZ,
            observer,
          );
          renderX = Math.fround(this.aberratedPosition[0] as number);
          renderY = Math.fround(this.aberratedPosition[1] as number);
          renderZ = Math.fround(this.aberratedPosition[2] as number);
        } else {
          renderX = Math.fround(relativeX);
          renderY = Math.fround(relativeY);
          renderZ = Math.fround(relativeZ);
        }
        target[component] = renderX;
        target[component + 1] = renderY;
        target[component + 2] = renderZ;
        minimumX = Math.min(minimumX, renderX);
        minimumY = Math.min(minimumY, renderY);
        minimumZ = Math.min(minimumZ, renderZ);
        maximumX = Math.max(maximumX, renderX);
        maximumY = Math.max(maximumY, renderY);
        maximumZ = Math.max(maximumZ, renderZ);
      }
      attribute.needsUpdate = true;
      if (visual.frustumCulled) {
        const boundingSphere = visual.geometry.boundingSphere;
        if (boundingSphere === null) {
          throw new Error('Frustum-culled packed positions require a setup-time bounding sphere.');
        }
        const centerX = (minimumX + maximumX) * 0.5;
        const centerY = (minimumY + maximumY) * 0.5;
        const centerZ = (minimumZ + maximumZ) * 0.5;
        let maximumRadiusSquared = 0;
        for (let component = 0; component < target.length; component += 3) {
          const x = (target[component] as number) - centerX;
          const y = (target[component + 1] as number) - centerY;
          const z = (target[component + 2] as number) - centerZ;
          maximumRadiusSquared = Math.max(maximumRadiusSquared, x * x + y * y + z * z);
        }
        boundingSphere.center.set(centerX, centerY, centerZ);
        boundingSphere.radius = Math.sqrt(maximumRadiusSquared);
      }
    }

    for (
      let bindingIndex = 0;
      bindingIndex < this.packedPointAttributes.length;
      bindingIndex += 1
    ) {
      const positionsKm = this.packedPointPositionsKm[bindingIndex];
      const attribute = this.packedPointAttributes[bindingIndex];
      const points = this.packedPointVisuals[bindingIndex];
      if (positionsKm === undefined || attribute === undefined || points === undefined) {
        throw new Error('Packed point binding arrays are out of sync.');
      }
      const target = attribute.array as Float32Array;
      const maximumPointCount = target.length / 3;
      const firstPoint = Math.min(
        maximumPointCount,
        Math.max(0, Math.floor(points.geometry.drawRange.start)),
      );
      const requestedCount = points.geometry.drawRange.count;
      const activePointCount = Math.min(
        maximumPointCount - firstPoint,
        Number.isFinite(requestedCount)
          ? Math.max(0, Math.floor(requestedCount))
          : maximumPointCount - firstPoint,
      );
      const boundingSphere = points.geometry.boundingSphere;
      if (points.frustumCulled && boundingSphere === null) {
        throw new Error('Frustum-culled packed points require a setup-time bounding sphere.');
      }
      if (activePointCount === 0) {
        if (boundingSphere !== null) {
          boundingSphere.center.set(0, 0, 0);
          boundingSphere.radius = 0;
        }
        continue;
      }
      const finalPoint = firstPoint + activePointCount;
      for (let pointIndex = firstPoint; pointIndex < finalPoint; pointIndex += 1) {
        const component = pointIndex * 3;
        const x = positionsKm[component] ?? Number.NaN;
        const y = positionsKm[component + 1] ?? Number.NaN;
        const z = positionsKm[component + 2] ?? Number.NaN;
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
          throw new RangeError('Packed point positions must contain finite coordinates.');
        }
        const relativeX = x - cameraPositionKm.x;
        const relativeY = y - cameraPositionKm.y;
        const relativeZ = z - cameraPositionKm.z;
        if (aberrationActive) {
          writeAberratedPositionInto(
            this.aberratedPosition,
            relativeX,
            relativeY,
            relativeZ,
            observer,
          );
          target[component] = Math.fround(this.aberratedPosition[0] as number);
          target[component + 1] = Math.fround(this.aberratedPosition[1] as number);
          target[component + 2] = Math.fround(this.aberratedPosition[2] as number);
        } else {
          target[component] = Math.fround(relativeX);
          target[component + 1] = Math.fround(relativeY);
          target[component + 2] = Math.fround(relativeZ);
        }
      }
      attribute.needsUpdate = true;
      if (points.frustumCulled) {
        const activeBoundingSphere = boundingSphere;
        if (activeBoundingSphere === null) {
          throw new Error('Frustum-culled packed points require a setup-time bounding sphere.');
        }
        let minimumX = Number.POSITIVE_INFINITY;
        let minimumY = Number.POSITIVE_INFINITY;
        let minimumZ = Number.POSITIVE_INFINITY;
        let maximumX = Number.NEGATIVE_INFINITY;
        let maximumY = Number.NEGATIVE_INFINITY;
        let maximumZ = Number.NEGATIVE_INFINITY;
        for (let pointIndex = firstPoint; pointIndex < finalPoint; pointIndex += 1) {
          const offset = pointIndex * 3;
          const x = target[offset] as number;
          const y = target[offset + 1] as number;
          const z = target[offset + 2] as number;
          minimumX = Math.min(minimumX, x);
          minimumY = Math.min(minimumY, y);
          minimumZ = Math.min(minimumZ, z);
          maximumX = Math.max(maximumX, x);
          maximumY = Math.max(maximumY, y);
          maximumZ = Math.max(maximumZ, z);
        }
        const centerX = (minimumX + maximumX) * 0.5;
        const centerY = (minimumY + maximumY) * 0.5;
        const centerZ = (minimumZ + maximumZ) * 0.5;
        let maximumRadiusSquared = 0;
        for (let pointIndex = firstPoint; pointIndex < finalPoint; pointIndex += 1) {
          const offset = pointIndex * 3;
          const x = (target[offset] as number) - centerX;
          const y = (target[offset + 1] as number) - centerY;
          const z = (target[offset + 2] as number) - centerZ;
          maximumRadiusSquared = Math.max(maximumRadiusSquared, x * x + y * y + z * z);
        }
        activeBoundingSphere.center.set(centerX, centerY, centerZ);
        activeBoundingSphere.radius = Math.sqrt(maximumRadiusSquared);
      }
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
        const startRelativeX = (binding.positionsKm[startOffset] as number) - cameraPositionKm.x;
        const startRelativeY =
          (binding.positionsKm[startOffset + 1] as number) - cameraPositionKm.y;
        const startRelativeZ =
          (binding.positionsKm[startOffset + 2] as number) - cameraPositionKm.z;
        let startX: number;
        let startY: number;
        let startZ: number;
        if (aberrationActive) {
          writeAberratedPositionInto(
            this.aberratedPosition,
            startRelativeX,
            startRelativeY,
            startRelativeZ,
            observer,
          );
          startX = Math.fround(this.aberratedPosition[0] as number);
          startY = Math.fround(this.aberratedPosition[1] as number);
          startZ = Math.fround(this.aberratedPosition[2] as number);
        } else {
          startX = Math.fround(startRelativeX);
          startY = Math.fround(startRelativeY);
          startZ = Math.fround(startRelativeZ);
        }

        const endRelativeX = (binding.positionsKm[endOffset] as number) - cameraPositionKm.x;
        const endRelativeY = (binding.positionsKm[endOffset + 1] as number) - cameraPositionKm.y;
        const endRelativeZ = (binding.positionsKm[endOffset + 2] as number) - cameraPositionKm.z;
        let endX: number;
        let endY: number;
        let endZ: number;
        if (aberrationActive) {
          writeAberratedPositionInto(
            this.aberratedPosition,
            endRelativeX,
            endRelativeY,
            endRelativeZ,
            observer,
          );
          endX = Math.fround(this.aberratedPosition[0] as number);
          endY = Math.fround(this.aberratedPosition[1] as number);
          endZ = Math.fround(this.aberratedPosition[2] as number);
        } else {
          endX = Math.fround(endRelativeX);
          endY = Math.fround(endRelativeY);
          endZ = Math.fround(endRelativeZ);
        }
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
        const relativeX = (binding.positionsKm[pointOffset] as number) - cameraPositionKm.x;
        const relativeY = (binding.positionsKm[pointOffset + 1] as number) - cameraPositionKm.y;
        const relativeZ = (binding.positionsKm[pointOffset + 2] as number) - cameraPositionKm.z;
        let pointX: number;
        let pointY: number;
        let pointZ: number;
        if (aberrationActive) {
          writeAberratedPositionInto(
            this.aberratedPosition,
            relativeX,
            relativeY,
            relativeZ,
            observer,
          );
          pointX = Math.fround(this.aberratedPosition[0] as number);
          pointY = Math.fround(this.aberratedPosition[1] as number);
          pointZ = Math.fround(this.aberratedPosition[2] as number);
        } else {
          pointX = Math.fround(relativeX);
          pointY = Math.fround(relativeY);
          pointZ = Math.fround(relativeZ);
        }
        const x = pointX - centerX;
        const y = pointY - centerY;
        const z = pointZ - centerZ;
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
