import { Object3D } from 'three';
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
});
