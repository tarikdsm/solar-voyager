import { PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import type { CameraPose } from '../game/cameraDirector.js';
import { applyCameraPose } from './cameraRig.js';

function pose(overrides: Partial<CameraPose> = {}): CameraPose {
  return {
    positionKm: { x: 0, y: 0, z: 0 },
    lookDirection: { x: 0, y: 0, z: -1 },
    upDirection: { x: 0, y: 1, z: 0 },
    fovDeg: 75,
    ...overrides,
  };
}

describe('applyCameraPose', () => {
  it('aims the camera along the pose direction from the render origin', () => {
    const camera = new PerspectiveCamera(75, 1, 0.001, 1e10);
    applyCameraPose(camera, pose({ lookDirection: { x: 1, y: 0, z: 0 } }));

    // Camera-relative rendering keeps the camera at the origin, so `lookAt` is
    // handed a unit direction rather than a world point.
    const forward = camera.getWorldDirection(new Vector3());
    expect(forward.x).toBeCloseTo(1, 12);
    expect(forward.y).toBeCloseTo(0, 12);
    expect(forward.z).toBeCloseTo(0, 12);
    expect(camera.position.toArray()).toEqual([0, 0, 0]);
  });

  it('rolls the camera with the pose up vector', () => {
    const camera = new PerspectiveCamera(75, 1, 0.001, 1e10);
    applyCameraPose(
      camera,
      pose({ lookDirection: { x: 1, y: 0, z: 0 }, upDirection: { x: 0, y: 0, z: 1 } }),
    );
    const cameraUp = new Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    expect(cameraUp.z).toBeCloseTo(1, 12);

    applyCameraPose(
      camera,
      pose({ lookDirection: { x: 1, y: 0, z: 0 }, upDirection: { x: 0, y: 0, z: -1 } }),
    );
    expect(new Vector3(0, 1, 0).applyQuaternion(camera.quaternion).z).toBeCloseTo(-1, 12);
  });

  it('rebuilds the projection only when the field of view actually moves', () => {
    const camera = new PerspectiveCamera(75, 1, 0.001, 1e10);
    let rebuilds = 0;
    const original = camera.updateProjectionMatrix.bind(camera);
    camera.updateProjectionMatrix = (): void => {
      rebuilds += 1;
      original();
    };

    applyCameraPose(camera, pose());
    expect(rebuilds).toBe(0);
    // The chase widening approaches its target exponentially and never quite
    // arrives; without the threshold this would rebuild forever.
    applyCameraPose(camera, pose({ fovDeg: 75.000_01 }));
    expect(rebuilds).toBe(0);
    applyCameraPose(camera, pose({ fovDeg: 79 }));
    expect(rebuilds).toBe(1);
    expect(camera.fov).toBe(79);
  });

  it('leaves the world matrix current for the frame that follows', () => {
    const camera = new PerspectiveCamera(75, 1, 0.001, 1e10);
    camera.matrixWorldNeedsUpdate = true;
    applyCameraPose(camera, pose({ lookDirection: { x: 0, y: 1, z: 0 } }));
    expect(camera.matrixWorldNeedsUpdate).toBe(false);
  });
});
