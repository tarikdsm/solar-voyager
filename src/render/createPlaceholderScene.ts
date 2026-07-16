import { AmbientLight, BoxGeometry, DirectionalLight, Mesh, MeshStandardMaterial } from 'three';

import type { ReadonlyVec3 } from '../core/vec3.js';
import { CameraRelativeSpaceScene } from './spaceScene.js';

const PLACEHOLDER_BODY_POSITION_KM: ReadonlyVec3 = {
  x: 149_597_870.7,
  y: 0,
  z: 0,
};

const PLACEHOLDER_CAMERA_POSITION_KM: ReadonlyVec3 = {
  x: 149_597_870.7,
  y: 0,
  z: 5,
};

export interface PlaceholderScene {
  readonly spaceScene: CameraRelativeSpaceScene;
  readonly scene: CameraRelativeSpaceScene['scene'];
  readonly camera: CameraRelativeSpaceScene['camera'];
  readonly cube: Mesh<BoxGeometry, MeshStandardMaterial>;
  readonly cameraPositionKm: ReadonlyVec3;
}

/** Creates the setup-only scene objects used by the initial scaffold. */
export function createPlaceholderScene(): PlaceholderScene {
  const spaceScene = new CameraRelativeSpaceScene();
  const { scene, camera } = spaceScene;

  const geometry = new BoxGeometry(1, 1, 1);
  const material = new MeshStandardMaterial({ color: 0x2f80ed });
  const cube = new Mesh(geometry, material);
  spaceScene.bindVisual(cube, PLACEHOLDER_BODY_POSITION_KM);

  const ambientLight = new AmbientLight(0xffffff, 1);
  ambientLight.matrixAutoUpdate = false;
  ambientLight.updateMatrix();
  const directionalLight = new DirectionalLight(0xffffff, 2);
  directionalLight.position.set(3, 4, 5);
  directionalLight.matrixAutoUpdate = false;
  directionalLight.updateMatrix();

  scene.add(ambientLight, directionalLight);
  spaceScene.updateCameraRelative(PLACEHOLDER_CAMERA_POSITION_KM);

  return {
    spaceScene,
    scene,
    camera,
    cube,
    cameraPositionKm: PLACEHOLDER_CAMERA_POSITION_KM,
  };
}
