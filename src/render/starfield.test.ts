import {
  AdditiveBlending,
  BufferAttribute,
  InterleavedBufferAttribute,
  LessEqualDepth,
  ShaderMaterial,
  Vector3,
} from 'three';
import { describe, expect, it, vi } from 'vitest';

import type { StarCatalog } from './starCatalog.js';
import { createRelativisticVisualState } from './relativisticVisualState.js';
import {
  STARFIELD_RADIUS_KM,
  Starfield,
  createMagnitudeOrderedStarIndices,
  magnitudeToStarOpacity,
  magnitudeToStarSizeCssPx,
} from './starfield.js';

function createCatalog(): StarCatalog {
  return {
    starCount: 3,
    strideFloats: 7,
    data: new Float32Array([
      1, 0, 0, -1, 1, 0.8, 0.6, 0, 1, 0, 1, 0.7, 0.8, 1, 0, 0, 1, 8, 0.4, 0.5, 0.6,
    ]),
  };
}

describe('star magnitude display mapping', () => {
  it('maps bright and faint stars to bounded pixel size and opacity', () => {
    expect(magnitudeToStarSizeCssPx(-2)).toBeCloseTo(1 + 1.5 * 10 ** 0.2, 12);
    expect(magnitudeToStarSizeCssPx(1)).toBeCloseTo(1 + 1.5 * 10 ** -0.1, 12);
    expect(magnitudeToStarSizeCssPx(8)).toBeCloseTo(1 + 1.5 * 10 ** -0.8, 12);
    expect(magnitudeToStarOpacity(-2)).toBe(1);
    expect(magnitudeToStarOpacity(1)).toBe(1);
    expect(magnitudeToStarOpacity(8)).toBeCloseTo(10 ** -2.8, 12);
  });
});

describe('Starfield', () => {
  it('builds one static points draw from the zero-copy interleaved catalog', () => {
    const catalog = createCatalog();
    const starfield = new Starfield(catalog, 2);
    const { geometry } = starfield.points;
    const position = geometry.getAttribute('position');
    const magnitude = geometry.getAttribute('aMagnitude');
    const color = geometry.getAttribute('aColor');
    const size = geometry.getAttribute('aSizeCssPx');
    const opacity = geometry.getAttribute('aOpacity');

    expect(position).toBeInstanceOf(InterleavedBufferAttribute);
    expect(magnitude).toBeInstanceOf(InterleavedBufferAttribute);
    expect(color).toBeInstanceOf(InterleavedBufferAttribute);
    expect((position as InterleavedBufferAttribute).data.array).toBe(catalog.data);
    expect((magnitude as InterleavedBufferAttribute).offset).toBe(3);
    expect((color as InterleavedBufferAttribute).offset).toBe(4);
    expect(color.count).toBe(catalog.starCount);
    expect(Array.from((color as InterleavedBufferAttribute).data.array.slice(4, 7))).toEqual(
      Array.from(catalog.data.slice(4, 7)),
    );
    expect(size).toBeInstanceOf(BufferAttribute);
    expect(opacity).toBeInstanceOf(BufferAttribute);
    const expectedSizes = new Float32Array([-1, 1, 8].map(magnitudeToStarSizeCssPx));
    const expectedOpacities = new Float32Array([-1, 1, 8].map(magnitudeToStarOpacity));
    expect(Array.from((size as BufferAttribute).array)).toEqual(Array.from(expectedSizes));
    expect(Array.from((opacity as BufferAttribute).array)).toEqual(Array.from(expectedOpacities));
    expect(Array.from(geometry.getIndex()?.array ?? [])).toEqual([0, 1, 2]);
    expect(geometry.drawRange).toEqual({ start: 0, count: catalog.starCount });
    expect(starfield.points.matrixAutoUpdate).toBe(false);
    expect(starfield.points.frustumCulled).toBe(false);
  });

  it('keeps the brightest stars across the source order when applying a prefix cap', () => {
    const catalog: StarCatalog = {
      starCount: 6,
      strideFloats: 7,
      data: new Float32Array([
        1, 0, 0, 8, 1, 1, 1, 0.8, 0.2, 0, 7, 1, 1, 1, 0.5, 0.5, 0, -1, 1, 1, 1, -0.5, 0.5, 0, 0, 1,
        1, 1, -0.8, 0.2, 0, 6, 1, 1, 1, -1, 0, 0, 5, 1, 1, 1,
      ]),
    };

    expect(Array.from(createMagnitudeOrderedStarIndices(catalog))).toEqual([2, 3, 5, 4, 1, 0]);
    const starfield = new Starfield(catalog, 1);
    starfield.setCountCap(2);
    const order = Array.from(starfield.points.geometry.getIndex()?.array ?? []).slice(0, 2);
    expect(order).toEqual([2, 3]);
    expect(order.map((index) => catalog.data[index * 7])).toEqual([0.5, -0.5]);
  });

  it('uses fixed-radius far-plane additive rendering with pixel-ratio control', () => {
    const starfield = new Starfield(createCatalog(), 2);
    const material = starfield.points.material as ShaderMaterial;

    expect(material).toBeInstanceOf(ShaderMaterial);
    expect(material.uniforms.uRadiusKm?.value).toBe(STARFIELD_RADIUS_KM);
    expect(material.uniforms.uPixelRatio?.value).toBe(2);
    expect(material.vertexShader).toContain('observedDirection * uRadiusKm');
    expect(material.vertexShader).toContain('#ifdef USE_REVERSED_DEPTH_BUFFER');
    expect(material.vertexShader).toContain('clipPosition.z = 0.0');
    expect(material.vertexShader).toContain('clipPosition.z = clipPosition.w');
    expect(material.depthTest).toBe(true);
    expect(material.depthFunc).toBe(LessEqualDepth);
    expect(material.depthWrite).toBe(false);
    expect(material.transparent).toBe(true);
    expect(material.blending).toBe(AdditiveBlending);

    starfield.setPixelRatio(1.5);
    expect(material.uniforms.uPixelRatio?.value).toBe(1.5);
    expect(() => starfield.setPixelRatio(0)).toThrow(/pixel ratio/iu);
    expect(() => starfield.setPixelRatio(Number.NaN)).toThrow(/pixel ratio/iu);

    starfield.setCountCap(2);
    expect(starfield.points.geometry.drawRange.count).toBe(2);
    starfield.setCountCap(9_000);
    expect(starfield.points.geometry.drawRange.count).toBe(3);
    expect(() => starfield.setCountCap(0)).toThrow(/count cap/iu);
  });

  it('disposes its setup resources deterministically', () => {
    const starfield = new Starfield(createCatalog(), 1);
    const geometryDispose = vi.spyOn(starfield.points.geometry, 'dispose');
    const materialDispose = vi.spyOn(starfield.points.material as ShaderMaterial, 'dispose');

    starfield.dispose();

    expect(geometryDispose).toHaveBeenCalledOnce();
    expect(materialDispose).toHaveBeenCalledOnce();
  });

  it('updates stable observer uniforms and aberrates directions before projection', () => {
    const starfield = new Starfield(createCatalog(), 1);
    const material = starfield.points.material as ShaderMaterial;
    const betaUniform = material.uniforms.uObserverBeta;
    const gammaUniform = material.uniforms.uObserverGamma;
    const activationUniform = material.uniforms.uRelativisticActivation;
    const state = createRelativisticVisualState();
    state.betaX = 0.1;
    state.betaY = -0.2;
    state.betaZ = 0.3;
    state.gamma = 1.08;
    state.activation = 0.75;

    starfield.setRelativisticObserver(state);

    expect(material.uniforms.uObserverBeta).toBe(betaUniform);
    expect(material.uniforms.uObserverGamma).toBe(gammaUniform);
    expect(material.uniforms.uRelativisticActivation).toBe(activationUniform);
    expect(betaUniform?.value).toBeInstanceOf(Vector3);
    expect((betaUniform?.value as Vector3).toArray()).toEqual([0.1, -0.2, 0.3]);
    expect(gammaUniform?.value).toBe(1.08);
    expect(activationUniform?.value).toBe(0.75);
    expect(material.vertexShader).toContain('((uObserverGamma - 1.0) / betaSquared)');
    expect(material.vertexShader).toContain('uObserverGamma * (1.0 + betaDotDirection)');
    expect(material.vertexShader).toContain('normalize(mix(direction, observedDirection');
    expect(material.vertexShader.indexOf('observedDirection * uRadiusKm')).toBeLessThan(
      material.vertexShader.indexOf('projectionMatrix * viewPosition'),
    );
  });
});
