import {
  AmbientLight,
  BoxGeometry,
  DirectionalLight,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
} from 'three';

export interface PlaceholderScene {
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  readonly cube: Mesh<BoxGeometry, MeshStandardMaterial>;
}

/** Creates the setup-only scene objects used by the initial scaffold. */
export function createPlaceholderScene(): PlaceholderScene {
  const scene = new Scene();
  const camera = new PerspectiveCamera(75, 1, 0.1, 1_000);
  camera.position.z = 5;

  const geometry = new BoxGeometry(1, 1, 1);
  const material = new MeshStandardMaterial({ color: 0x2f80ed });
  const cube = new Mesh(geometry, material);
  cube.matrixAutoUpdate = false;
  cube.updateMatrix();

  const ambientLight = new AmbientLight(0xffffff, 1);
  const directionalLight = new DirectionalLight(0xffffff, 2);
  directionalLight.position.set(3, 4, 5);

  scene.add(cube, ambientLight, directionalLight);

  return { scene, camera, cube };
}
