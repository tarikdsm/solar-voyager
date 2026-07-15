import { AmbientLight, DirectionalLight, Material, Mesh } from 'three';
import { describe, expect, it } from 'vitest';

import { createPlaceholderScene } from './createPlaceholderScene.js';

describe('createPlaceholderScene', () => {
  it('creates one stable setup-only cube with ambient and directional lighting', () => {
    const { scene, camera, cube } = createPlaceholderScene();
    const meshes: Mesh[] = [];
    const ambientLights: AmbientLight[] = [];
    const directionalLights: DirectionalLight[] = [];

    scene.traverse((object) => {
      if (object instanceof Mesh) {
        meshes.push(object);
      }
      if (object instanceof AmbientLight) {
        ambientLights.push(object);
      }
      if (object instanceof DirectionalLight) {
        directionalLights.push(object);
      }
    });

    expect(meshes).toHaveLength(1);
    expect(ambientLights).toHaveLength(1);
    expect(directionalLights).toHaveLength(1);
    expect(meshes[0]).toBe(cube);
    expect(camera.position.z).not.toBe(0);
    expect(cube.geometry).toBeDefined();
    expect(cube.material).toBeInstanceOf(Material);
    expect(cube.matrixAutoUpdate).toBe(false);
  });
});
