import { AmbientLight, DirectionalLight, Material, Mesh, Object3D } from 'three';
import { describe, expect, it, vi } from 'vitest';

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
    expect(camera.position.toArray()).toEqual([0, 0, 0]);
    expect(cube.position.toArray()).toEqual([0, 0, -5]);
    expect(cube.geometry).toBeDefined();
    expect(cube.material).toBeInstanceOf(Material);
    expect(cube.matrixAutoUpdate).toBe(false);
  });

  it('initializes each static object matrix during setup', () => {
    const updateMatrixSpy = vi.spyOn(Object3D.prototype, 'updateMatrix');

    try {
      const { scene, camera } = createPlaceholderScene();
      const ambientLight = scene.children.find((object) => object instanceof AmbientLight);
      const directionalLight = scene.children.find((object) => object instanceof DirectionalLight);

      expect(camera.matrixAutoUpdate).toBe(false);
      expect(ambientLight?.matrixAutoUpdate).toBe(false);
      expect(directionalLight?.matrixAutoUpdate).toBe(false);
      expect(updateMatrixSpy.mock.contexts.filter((context) => context === camera)).toHaveLength(1);
      expect(
        updateMatrixSpy.mock.contexts.filter((context) => context === ambientLight),
      ).toHaveLength(1);
      expect(
        updateMatrixSpy.mock.contexts.filter((context) => context === directionalLight),
      ).toHaveLength(2);
      expect(directionalLight?.matrix.elements.slice(12, 15)).toEqual([3, 4, 5]);
    } finally {
      updateMatrixSpy.mockRestore();
    }
  });
});
