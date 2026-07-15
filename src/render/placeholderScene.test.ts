import { describe, expect, it } from 'vitest';
import * as THREE from 'three';

import { createPlaceholderScene } from './createPlaceholderScene';

describe('createPlaceholderScene', () => {
  it('allocates the complete static placeholder scene during setup', () => {
    const { scene, camera, cube } = createPlaceholderScene();
    const meshes = scene.children.filter(
      (child): child is THREE.Mesh => child instanceof THREE.Mesh,
    );
    const ambientLights = scene.children.filter(
      (child): child is THREE.AmbientLight =>
        child instanceof THREE.AmbientLight,
    );
    const directionalLights = scene.children.filter(
      (child): child is THREE.DirectionalLight =>
        child instanceof THREE.DirectionalLight,
    );

    expect(meshes).toHaveLength(1);
    expect(ambientLights).toHaveLength(1);
    expect(directionalLights).toHaveLength(1);
    expect(cube.geometry).toBeInstanceOf(THREE.BoxGeometry);
    expect(cube.material).toBeInstanceOf(THREE.MeshStandardMaterial);
    expect(camera.position.z).not.toBe(0);
    expect(cube.matrixAutoUpdate).toBe(false);
  });
});
