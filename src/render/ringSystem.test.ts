import {
  DataTexture,
  Group,
  Mesh,
  MeshStandardMaterial,
  Quaternion,
  RGBAFormat,
  Vector3,
  type WebGLProgramParametersWithUniforms,
} from 'three';
import { describe, expect, it, vi } from 'vitest';

import { ringDefinitionFor } from './ringCatalog.js';
import { prepareRingSystem } from './ringSystem.js';

function definition(id: 'jupiter' | 'saturn') {
  const result = ringDefinitionFor(id);
  if (result === null) throw new Error(`Missing ${id} test definition.`);
  return result;
}

function fixture(id: 'jupiter' | 'saturn' = 'saturn', axialTiltRad = 0.4) {
  const root = new Group();
  const surface = new MeshStandardMaterial();
  surface.name = 'mat_surface';
  const rings = new MeshStandardMaterial();
  rings.name = 'mat_rings';
  rings.map = new DataTexture(new Uint8Array([255, 220, 180, 180]), 1, 1, RGBAFormat);
  const surfaceMesh = new Mesh(undefined, surface);
  const ringMesh = new Mesh(undefined, rings);
  root.add(surfaceMesh, ringMesh);
  const prepared = prepareRingSystem(root, [surface, rings], definition(id), {
    axialTiltRad,
    meanRadiusKm: id === 'saturn' ? 60_268 : 71_492,
    muKm3S2: id === 'saturn' ? 37_931_207.8 : 126_686_534.911,
    polarRadiusRatio: id === 'saturn' ? 0.902 : 0.935,
  });
  if (prepared === null) throw new Error('Expected a prepared ring system.');
  return { prepared, ringMesh, rings, root, surface };
}

function shader(): WebGLProgramParametersWithUniforms {
  return {
    uniforms: {},
    vertexShader: '#include <common>\n#include <begin_vertex>\n#include <project_vertex>',
    fragmentShader: '#include <common>\n#include <map_fragment>\n#include <output_fragment>',
  } as WebGLProgramParametersWithUniforms;
}

describe('prepareRingSystem', () => {
  it('pairs exact materials, leaves the tilt to bodySpin, and attaches particles only to Saturn', () => {
    const saturn = fixture('saturn', 0.4665);
    const jupiter = fixture('jupiter', 0.0546);

    // T0128: exactly one tilt owner. `prepareRingSystem` must not write the root
    // transform any more, or the tilt lands twice once bodySpin publishes it.
    expect(saturn.root.rotation.z).toBe(0);
    expect(saturn.root.quaternion.equals(new Quaternion())).toBe(true);
    expect(jupiter.root.quaternion.equals(new Quaternion())).toBe(true);
    expect(saturn.prepared.particleMesh?.name).toBe('saturn_ring_particles');
    expect(saturn.prepared.particleMesh?.parent).toBe(saturn.root);
    expect(jupiter.prepared.particleMesh).toBeNull();

    saturn.prepared.dispose();
    jupiter.prepared.dispose();
  });

  it('rejects incomplete or ambiguous ring assets while ignoring unrelated models', () => {
    const root = new Group();
    const surface = new MeshStandardMaterial();
    surface.name = 'mat_surface';
    const rings = new MeshStandardMaterial();
    rings.name = 'mat_rings';
    rings.map = new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, RGBAFormat);
    root.add(new Mesh(undefined, surface));
    const body = {
      axialTiltRad: 0,
      meanRadiusKm: 60_268,
      muKm3S2: 37_931_207.8,
      polarRadiusRatio: 0.902,
    };

    expect(prepareRingSystem(root, [], definition('saturn'), body)).toBeNull();
    expect(() => prepareRingSystem(root, [surface], definition('saturn'), body)).toThrow(
      /incomplete/iu,
    );
    expect(() =>
      prepareRingSystem(root, [surface, surface, rings], definition('saturn'), body),
    ).toThrow(/exactly one/iu);
  });

  it('transforms camera and Sun into the stable local frame without replacing uniforms', () => {
    const { prepared, rings, surface } = fixture('saturn', 0);
    const surfaceShader = shader();
    const ringShader = shader();
    surface.onBeforeCompile(surfaceShader, {} as never);
    rings.onBeforeCompile(ringShader, {} as never);
    const direction = surfaceShader.uniforms.uRingSunDirection?.value;
    const middleRadiusKm = (66_900 + 140_612) / 2;

    // Untilted body: world +Z is the pole, so the model frame is (x, z, -y).
    prepared.update(middleRadiusKm, 0, 0, 3, 4, 0, 123_456, 0);

    expect(surfaceShader.uniforms.uRingSunDirection?.value).toBe(direction);
    expect((direction as { toArray(): number[] }).toArray()).toEqual([0.6, 0, -0.8]);
    expect(ringShader.uniforms.uRingSunDirection?.value).toBe(direction);
    expect(prepared.blend).toBe(1);
    expect(prepared.particleMesh?.count).toBe(4096);
    expect(surfaceShader.uniforms.uRingRepresentationBlend?.value).toBe(1);

    prepared.setParticleCount(1024);
    prepared.update(middleRadiusKm, 0, 0, 3, 4, 0, 123_457, 0);
    expect(prepared.particleMesh?.count).toBe(1024);
    prepared.dispose();
  });

  it('spins the annulus with its planet while the particle field stays inertial', () => {
    const { prepared, surface } = fixture('saturn', 0);
    const surfaceShader = shader();
    surface.onBeforeCompile(surfaceShader, {} as never);
    const direction = surfaceShader.uniforms.uRingSunDirection?.value as Vector3;
    const middleRadiusKm = (66_900 + 140_612) / 2;
    const particleMesh = prepared.particleMesh;
    if (particleMesh === null) throw new Error('Expected Saturn particles.');
    const spinAngleRad = 0.7;

    // Camera on the +X ring radius; with the spin applied the annulus frame has
    // turned, so the Sun uniform must turn with it...
    prepared.update(middleRadiusKm, 0, 0, 1, 0, 0, 0, spinAngleRad);
    expect(direction.x).toBeCloseTo(Math.cos(spinAngleRad), 12);
    expect(direction.y).toBeCloseTo(0, 12);
    expect(direction.z).toBeCloseTo(Math.sin(spinAngleRad), 12);

    // ...while the particle field is counter-spun back into the equatorial frame
    // and still addressed by a camera expressed there, so its Keplerian streaming
    // never inherits the parent's angular velocity.
    expect(particleMesh.quaternion.x).toBe(0);
    expect(particleMesh.quaternion.z).toBe(0);
    expect(particleMesh.quaternion.y).toBeCloseTo(-Math.sin(spinAngleRad / 2), 12);
    expect(particleMesh.quaternion.w).toBeCloseTo(Math.cos(spinAngleRad / 2), 12);
    const patchOrigin = particleMesh.material.uniforms.uRingPatchOrigin?.value as Vector3;
    expect(patchOrigin.x).toBeCloseTo(middleRadiusKm / 60_268, 9);
    expect(patchOrigin.y).toBe(0);
    expect(patchOrigin.z).toBeCloseTo(0, 9);
    expect(prepared.blend).toBe(1);

    expect(() => prepared.update(middleRadiusKm, 0, 0, 1, 0, 0, 0, Number.NaN)).toThrow(/finite/iu);
    prepared.dispose();
  });

  it('disposes the optional field once and detaches it from the model', () => {
    const { prepared, root } = fixture();
    const particleMesh = prepared.particleMesh;
    if (particleMesh === null) throw new Error('Expected Saturn particles.');
    const geometryDispose = vi.spyOn(particleMesh.geometry, 'dispose');
    const materialDispose = vi.spyOn(particleMesh.material, 'dispose');

    prepared.dispose();
    prepared.dispose();

    expect(particleMesh.parent).toBeNull();
    expect(root.children).not.toContain(particleMesh);
    expect(geometryDispose).toHaveBeenCalledOnce();
    expect(materialDispose).toHaveBeenCalledOnce();
  });
});
