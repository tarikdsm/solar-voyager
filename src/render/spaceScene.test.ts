import {
  BufferGeometry,
  Float32BufferAttribute,
  InterleavedBufferAttribute,
  Object3D,
  Points,
  PointsMaterial,
} from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { describe, expect, it } from 'vitest';

import { CameraRelativeSpaceScene, SPACE_FAR_KM, SPACE_NEAR_KM } from './spaceScene.js';

const AU_KM = 149_597_870.7;
const EARTH_RADIUS_KM = 6_371.0084;

describe('CameraRelativeSpaceScene', () => {
  it('locks the camera to the origin with the solar-system frustum', () => {
    const spaceScene = new CameraRelativeSpaceScene();

    expect(spaceScene.camera.position.toArray()).toEqual([0, 0, 0]);
    expect(spaceScene.camera.near).toBe(SPACE_NEAR_KM);
    expect(spaceScene.camera.far).toBe(SPACE_FAR_KM);
    expect(SPACE_NEAR_KM).toBe(0.001);
    expect(SPACE_FAR_KM).toBe(1e10);
    expect(spaceScene.camera.matrixAutoUpdate).toBe(false);
  });

  it('subtracts in float64 before the float32 bridge for an Earth surface view', () => {
    const spaceScene = new CameraRelativeSpaceScene();
    const earth = new Object3D();
    const originalPositionObject = earth.position;
    const earthPositionKm = { x: AU_KM, y: -42_000_000.25, z: 7_500_000.125 };
    const centerDistanceKm = EARTH_RADIUS_KM + 200;
    const cameraPositionKm = {
      x: earthPositionKm.x + centerDistanceKm,
      y: earthPositionKm.y,
      z: earthPositionKm.z,
    };
    spaceScene.bindVisual(earth, earthPositionKm);

    spaceScene.updateCameraRelative(cameraPositionKm);

    expect(earth.position).toBe(originalPositionObject);
    expect(earth.position.toArray()).toEqual([Math.fround(-centerDistanceKm), 0, 0]);
    expect(Math.abs(earth.position.x + centerDistanceKm)).toBeLessThan(0.001);
    expect(earth.matrixAutoUpdate).toBe(false);
    expect(spaceScene.camera.position.toArray()).toEqual([0, 0, 0]);
  });

  it('keeps one-AU coordinates bounded and recomputes instead of accumulating', () => {
    const spaceScene = new CameraRelativeSpaceScene();
    const earth = new Object3D();
    const earthPositionKm = { x: AU_KM, y: 0, z: 0 };
    const farCameraKm = { x: earthPositionKm.x + AU_KM, y: 0, z: 0 };
    const nearCameraKm = { x: earthPositionKm.x + EARTH_RADIUS_KM + 200, y: 0, z: 0 };
    spaceScene.bindVisual(earth, earthPositionKm);

    spaceScene.updateCameraRelative(farCameraKm);
    const firstFarX = earth.position.x;
    expect(Math.abs(firstFarX + AU_KM)).toBeLessThanOrEqual(16);
    expect(Math.abs(firstFarX)).toBeLessThan(SPACE_FAR_KM);

    spaceScene.updateCameraRelative(nearCameraKm);
    spaceScene.updateCameraRelative(farCameraKm);
    expect(earth.position.x).toBe(firstFarX);
  });

  it('rejects duplicate bindings and non-finite boundary inputs', () => {
    const spaceScene = new CameraRelativeSpaceScene();
    const visual = new Object3D();
    const positionKm = { x: 1, y: 2, z: 3 };
    spaceScene.bindVisual(visual, positionKm);

    expect(() => spaceScene.bindVisual(visual, positionKm)).toThrow('already bound');
    expect(() => spaceScene.updateCameraRelative({ x: Number.NaN, y: 0, z: 0 })).toThrow(
      'camera position',
    );
  });

  it('binds packed roots at component offsets and recomputes after a camera round-trip', () => {
    const spaceScene = new CameraRelativeSpaceScene();
    const first = new Object3D();
    const second = new Object3D();
    const positionsKm = new Float64Array([
      AU_KM + 10.25,
      -42_000_000.5,
      7_500_000.125,
      AU_KM - 20.5,
      -41_999_990.25,
      7_499_970.75,
    ]);
    const cameraPositionKm = { x: AU_KM, y: -42_000_000, z: 7_500_000 };

    spaceScene.bindPackedVisual(first, positionsKm, 0);
    spaceScene.bindPackedVisual(second, positionsKm, 3);
    spaceScene.updateCameraRelative(cameraPositionKm);
    const firstPosition = first.position.toArray();

    expect(firstPosition).toEqual([Math.fround(10.25), Math.fround(-0.5), Math.fround(0.125)]);
    expect(second.position.toArray()).toEqual([
      Math.fround(-20.5),
      Math.fround(9.75),
      Math.fround(-29.25),
    ]);

    spaceScene.updateCameraRelative({ x: 0, y: 0, z: 0 });
    spaceScene.updateCameraRelative(cameraPositionKm);
    expect(first.position.toArray()).toEqual(firstPosition);
  });

  it('unbinds a packed visual without retaining or updating it', () => {
    const spaceScene = new CameraRelativeSpaceScene();
    const visual = new Object3D();
    const positionsKm = new Float64Array([10, 20, 30]);
    spaceScene.bindPackedVisual(visual, positionsKm, 0);
    spaceScene.updateCameraRelative({ x: 0, y: 0, z: 0 });

    expect(spaceScene.unbindVisual(visual)).toBe(true);
    expect(spaceScene.scene.getObjectById(visual.id)).toBeUndefined();
    positionsKm[0] = 99;
    spaceScene.updateCameraRelative({ x: 0, y: 0, z: 0 });
    expect(visual.position.x).toBe(10);
    expect(spaceScene.unbindVisual(visual)).toBe(false);
  });

  it('updates one packed point attribute in place and marks it dirty', () => {
    const spaceScene = new CameraRelativeSpaceScene();
    const positionsKm = new Float64Array([AU_KM + 10.25, -1, 2, AU_KM - 20.5, 3, -4]);
    const target = new Float32Array(positionsKm.length);
    const attribute = new Float32BufferAttribute(target, 3);
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', attribute);
    const points = new Points(geometry, new PointsMaterial());
    const originalAttribute = geometry.getAttribute('position');
    const originalArray = attribute.array;
    const originalVersion = attribute.version;

    spaceScene.bindPackedPointPositions(points, positionsKm);
    spaceScene.updateCameraRelative({ x: AU_KM, y: 0, z: 0 });

    expect(geometry.getAttribute('position')).toBe(originalAttribute);
    expect(geometry.getAttribute('position').array).toBe(originalArray);
    expect(Array.from(attribute.array)).toEqual([
      Math.fround(10.25),
      -1,
      2,
      Math.fround(-20.5),
      3,
      -4,
    ]);
    expect(attribute.version).toBe(originalVersion + 1);
    expect(points.matrixAutoUpdate).toBe(false);
  });

  it('updates preallocated Line2 segments camera-relatively without replacing buffers', () => {
    const spaceScene = new CameraRelativeSpaceScene();
    const positionsKm = new Float64Array([
      AU_KM + 10,
      -1,
      2,
      AU_KM + 20,
      3,
      4,
      AU_KM - 5,
      10,
      20,
      AU_KM + 100,
      200,
      300,
    ]);
    const geometry = new LineGeometry();
    geometry.setPositions(new Float32Array(positionsKm.length));
    const line = new Line2(geometry, new LineMaterial());
    const startAttribute = geometry.getAttribute('instanceStart');
    expect(startAttribute).toBeInstanceOf(InterleavedBufferAttribute);
    if (!(startAttribute instanceof InterleavedBufferAttribute)) throw new Error('unreachable');
    const segmentBuffer = startAttribute.data;
    const originalArray = segmentBuffer.array;
    const originalVersion = segmentBuffer.version;

    const binding = spaceScene.bindPackedPolyline(line, positionsKm);
    binding.setPointCount(3);
    spaceScene.updateCameraRelative({ x: AU_KM, y: 0, z: 0 });

    expect(binding.maximumPointCount).toBe(4);
    expect(binding.pointCount).toBe(3);
    expect(geometry.instanceCount).toBe(2);
    expect(startAttribute.data).toBe(segmentBuffer);
    expect(startAttribute.data.array).toBe(originalArray);
    expect(Array.from(originalArray.slice(0, 12))).toEqual([
      10, -1, 2, 20, 3, 4, 20, 3, 4, -5, 10, 20,
    ]);
    expect(segmentBuffer.version).toBe(originalVersion + 1);
    expect(geometry.boundingSphere?.radius).toBeGreaterThan(0);

    spaceScene.updateCameraRelative({ x: AU_KM + 5, y: 0, z: 0 });
    expect(startAttribute.data.array).toBe(originalArray);
    expect(Array.from(originalArray.slice(0, 12))).toEqual([
      5, -1, 2, 15, 3, 4, 15, 3, 4, -10, 10, 20,
    ]);
    expect(segmentBuffer.version).toBe(originalVersion + 2);
  });

  it('validates packed Line2 point counts and removes bindings on unbind', () => {
    const spaceScene = new CameraRelativeSpaceScene();
    const positionsKm = new Float64Array([1, 2, 3, 4, 5, 6]);
    const geometry = new LineGeometry();
    geometry.setPositions(new Float32Array(positionsKm.length));
    const line = new Line2(geometry, new LineMaterial());
    const binding = spaceScene.bindPackedPolyline(line, positionsKm);

    expect(() => binding.setPointCount(-1)).toThrow(RangeError);
    expect(() => binding.setPointCount(1)).toThrow(RangeError);
    expect(() => binding.setPointCount(3)).toThrow(RangeError);
    binding.setPointCount(2);
    spaceScene.updateCameraRelative({ x: 0, y: 0, z: 0 });
    const beforeUnbind = Array.from(
      (geometry.getAttribute('instanceStart') as InterleavedBufferAttribute).data.array,
    );
    expect(spaceScene.unbindVisual(line)).toBe(true);
    positionsKm.fill(99);
    spaceScene.updateCameraRelative({ x: 0, y: 0, z: 0 });
    expect(
      Array.from((geometry.getAttribute('instanceStart') as InterleavedBufferAttribute).data.array),
    ).toEqual(beforeUnbind);
  });

  it('rejects malformed packed bindings without adding partial scene state', () => {
    const spaceScene = new CameraRelativeSpaceScene();
    const visual = new Object3D();
    const valid = new Float64Array([1, 2, 3]);

    expect(() => spaceScene.bindPackedVisual(visual, valid, -1)).toThrow(RangeError);
    expect(() => spaceScene.bindPackedVisual(visual, valid, 1)).toThrow(RangeError);
    expect(() => spaceScene.bindPackedVisual(visual, new Float64Array([1, 2]), 0)).toThrow(
      RangeError,
    );

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(new Float32Array(6), 3));
    const points = new Points(geometry, new PointsMaterial());
    expect(() => spaceScene.bindPackedPointPositions(points, valid)).toThrow(RangeError);

    spaceScene.bindPackedVisual(visual, valid, 0);
    expect(() => spaceScene.bindPackedVisual(visual, valid, 0)).toThrow('already bound');
  });
});
