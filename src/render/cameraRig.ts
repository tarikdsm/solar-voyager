import type { PerspectiveCamera } from 'three';

import type { CameraPose } from '../game/cameraDirector.js';

/**
 * Smallest field-of-view change worth rebuilding the projection matrix for.
 *
 * The chase widening is a continuous exponential approach, so without a
 * threshold it would rebuild the matrix on literally every frame forever,
 * including long after the difference stopped being a fraction of a pixel.
 * 1e-4 deg is 1e-6 of the 75 deg base.
 */
const FOV_EPSILON_DEG = 1e-4;

/**
 * The whole three.js side of the camera: applies one `CameraPose` to the scene
 * camera.
 *
 * `CameraDirector` and its controllers are pure float64 `game/` modules that
 * know nothing about three.js — the same split `OrbitCameraController` has had
 * since v1. This is the adapter, and it is deliberately the only place that
 * knows the camera sits at the render origin (camera-relative rendering), which
 * is why `lookAt` is handed a unit *direction* rather than a world point.
 *
 * Allocation-free: `Vector3.set`, `Object3D.lookAt` and
 * `PerspectiveCamera.updateProjectionMatrix` all write in place in three.js
 * 0.185.
 */
export function applyCameraPose(camera: PerspectiveCamera, pose: CameraPose): void {
  camera.up.set(pose.upDirection.x, pose.upDirection.y, pose.upDirection.z);
  camera.lookAt(pose.lookDirection.x, pose.lookDirection.y, pose.lookDirection.z);
  if (Math.abs(camera.fov - pose.fovDeg) > FOV_EPSILON_DEG) {
    camera.fov = pose.fovDeg;
    camera.updateProjectionMatrix();
  }
  camera.updateMatrix();
  camera.updateMatrixWorld(true);
}
