import { InstancedBufferAttribute, ShaderMaterial, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import { ringDefinitionFor } from './ringCatalog.js';
import { RingParticleField } from './ringParticleField.js';

const SATURN_MU_KM3_S2 = 37_931_207.7;
const SATURN_RADIUS_KM = 60_268;

function saturnDefinition() {
  const definition = ringDefinitionFor('saturn');
  if (definition === null) throw new Error('Missing Saturn test definition.');
  return definition;
}

function uniforms(field: RingParticleField) {
  const material = field.mesh.material;
  if (!(material instanceof ShaderMaterial)) throw new Error('Expected one shader material.');
  return material.uniforms;
}

describe('RingParticleField', () => {
  it('builds one deterministic maximum-capacity instanced resource set', () => {
    const left = new RingParticleField(saturnDefinition(), SATURN_MU_KM3_S2, SATURN_RADIUS_KM);
    const right = new RingParticleField(saturnDefinition(), SATURN_MU_KM3_S2, SATURN_RADIUS_KM);
    const leftSeeds = left.mesh.geometry.getAttribute('aRingParticle');
    const rightSeeds = right.mesh.geometry.getAttribute('aRingParticle');

    expect(left.mesh.instanceMatrix.count).toBe(4096);
    expect(left.mesh.count).toBe(0);
    expect(left.mesh.frustumCulled).toBe(false);
    expect(left.mesh.matrixAutoUpdate).toBe(false);
    expect(left.mesh.material).toBeInstanceOf(ShaderMaterial);
    expect(leftSeeds).toBeInstanceOf(InstancedBufferAttribute);
    expect(Array.from(left.mesh.instanceMatrix.array)).toEqual(
      Array.from(right.mesh.instanceMatrix.array),
    );
    expect(Array.from(leftSeeds.array)).toEqual(Array.from(rightSeeds.array));
    expect((left.mesh.material as ShaderMaterial).vertexShader).toContain('sqrt( uParentMuKm3S2');

    left.dispose();
    right.dispose();
  });

  it('cross-fades continuously through bounded radial and vertical windows', () => {
    const definition = saturnDefinition();
    const particles = definition.particles;
    if (particles === null) throw new Error('Missing Saturn particle policy.');
    const field = new RingParticleField(definition, SATURN_MU_KM3_S2, SATURN_RADIUS_KM);
    const middleRadius =
      (definition.innerRadiusKm + definition.outerRadiusKm) / (2 * SATURN_RADIUS_KM);
    const patchRadius = particles.patchRadiusKm / SATURN_RADIUS_KM;

    expect(field.update(middleRadius, patchRadius * 1.01, 0, 0)).toBe(0);
    const shoulder = field.update(middleRadius, patchRadius * 0.625, 0, 1);
    expect(shoulder).toBeGreaterThan(0);
    expect(shoulder).toBeLessThan(1);
    expect(field.update(middleRadius, 0, 0, 2)).toBe(1);
    expect(field.update(middleRadius, -patchRadius * 0.625, 0, 3)).toBeCloseTo(shoulder);
    expect(field.update(middleRadius, -patchRadius * 1.01, 0, 4)).toBe(0);
    expect(field.update(definition.innerRadiusRatio - patchRadius * 1.01, 0, 0, 5)).toBe(0);

    field.setCountCap(2048);
    expect(field.update(middleRadius, 0, 0, 6)).toBe(1);
    expect(field.mesh.count).toBe(2048);
    field.setCountCap(0);
    expect(field.blend).toBe(0);
    expect(field.mesh.count).toBe(0);
    field.dispose();
  });

  it('accepts exact quality caps and rejects invalid physical inputs', () => {
    const field = new RingParticleField(saturnDefinition(), SATURN_MU_KM3_S2, SATURN_RADIUS_KM);

    for (const count of [4096, 2048, 1024, 0]) field.setCountCap(count);
    expect(() => field.setCountCap(4097)).toThrow(/count cap/u);
    expect(() => field.setCountCap(1.5)).toThrow(/count cap/u);
    expect(() => field.update(Number.NaN, 0, 0, 0)).toThrow(/camera/u);
    expect(() => field.update(2, 0, 0, Number.POSITIVE_INFINITY)).toThrow(/simulation/u);
    expect(() => new RingParticleField(saturnDefinition(), 0, SATURN_RADIUS_KM)).toThrow(
      /gravitational/u,
    );
    field.dispose();
  });

  it('reuses uniforms and keeps reduced orbital time bounded over long updates', () => {
    const field = new RingParticleField(saturnDefinition(), SATURN_MU_KM3_S2, SATURN_RADIUS_KM);
    const radius = 2;
    const state = uniforms(field);
    const patchOrigin = state.uRingPatchOrigin?.value as Vector3;
    const radialBasis = state.uRingRadialBasis?.value as Vector3;
    const tangentBasis = state.uRingTangentBasis?.value as Vector3;
    const material = field.mesh.material;
    const geometry = field.mesh.geometry;
    const periodSec =
      (Math.PI * 2) / Math.sqrt(SATURN_MU_KM3_S2 / Math.pow(radius * SATURN_RADIUS_KM, 3));

    for (let index = 0; index < 10_000; index += 1) {
      field.update(radius, 0, 0, index * 1_000_003.25);
      const reducedTime = state.uRingReducedTimeSec?.value as number;
      expect(reducedTime).toBeGreaterThanOrEqual(0);
      expect(reducedTime).toBeLessThan(periodSec);
    }

    field.update(radius, 0, 0, -1);
    expect(state.uRingReducedTimeSec?.value as number).toBeGreaterThanOrEqual(0);
    expect(state.uRingPatchOrigin?.value).toBe(patchOrigin);
    expect(state.uRingRadialBasis?.value).toBe(radialBasis);
    expect(state.uRingTangentBasis?.value).toBe(tangentBasis);
    expect(field.mesh.material).toBe(material);
    expect(field.mesh.geometry).toBe(geometry);
    field.dispose();
  });
});
