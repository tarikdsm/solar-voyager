import * as THREE from 'three';

export interface PlaceholderScene {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  cube: THREE.Mesh;
}

/** Creates the static scene objects used by the initial render scaffold. */
export function createPlaceholderScene(): PlaceholderScene {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(75, 1, 0.1, 1_000);
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const material = new THREE.MeshStandardMaterial({ color: 0x44aaff });
  const cube = new THREE.Mesh(geometry, material);
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
  const directionalLight = new THREE.DirectionalLight(0xffffff, 1);

  camera.position.z = 3;
  directionalLight.position.set(2, 2, 3);
  cube.matrixAutoUpdate = false;
  cube.updateMatrix();
  scene.add(cube, ambientLight, directionalLight);

  return { scene, camera, cube };
}
