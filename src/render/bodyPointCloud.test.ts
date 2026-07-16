import { AdditiveBlending, BufferAttribute, Points, ShaderMaterial } from 'three';
import { describe, expect, it } from 'vitest';

import { BodyPointCloud } from './bodyPointCloud.js';

describe('BodyPointCloud', () => {
  it('packs fifty bodies into one Points draw object and fixed attributes', () => {
    const colors = new Uint32Array(50);
    colors.fill(0x88aaff);
    const cloud = new BodyPointCloud(colors);

    expect(cloud.points).toBeInstanceOf(Points);
    expect(cloud.points.geometry.getAttribute('position').count).toBe(50);
    expect(cloud.points.geometry.getAttribute('aColor').count).toBe(50);
    expect(cloud.points.geometry.getAttribute('aSize').count).toBe(50);
    expect(cloud.points.geometry.getAttribute('aOpacity').count).toBe(50);
    expect(cloud.points.geometry.getAttribute('aIntensity').count).toBe(50);
    expect(cloud.points.material).toBeInstanceOf(ShaderMaterial);
    expect((cloud.points.material as ShaderMaterial).blending).toBe(AdditiveBlending);
    expect((cloud.points.material as ShaderMaterial).vertexShader).toContain(
      'gl_PointSize = max(aSize, 1.0001);',
    );
    expect((cloud.points.material as ShaderMaterial).vertexShader).not.toContain('max(aSize, 1.5)');
    expect((cloud.points.material as ShaderMaterial).vertexShader).toContain('logdepthbuf_vertex');
    expect(cloud.points.frustumCulled).toBe(false);
  });

  it('updates preallocated appearance arrays and caps point diameter at 1.5 px', () => {
    const cloud = new BodyPointCloud(new Uint32Array([0xffffff, 0xff0000]));
    const sizeAttribute = cloud.points.geometry.getAttribute('aSize');
    const opacityAttribute = cloud.points.geometry.getAttribute('aOpacity');
    const intensityAttribute = cloud.points.geometry.getAttribute('aIntensity');
    expect(sizeAttribute).toBeInstanceOf(BufferAttribute);
    expect(opacityAttribute).toBeInstanceOf(BufferAttribute);
    expect(intensityAttribute).toBeInstanceOf(BufferAttribute);
    const typedSizeAttribute = sizeAttribute as BufferAttribute;
    const typedOpacityAttribute = opacityAttribute as BufferAttribute;
    const typedIntensityAttribute = intensityAttribute as BufferAttribute;
    const originalSizeArray = sizeAttribute.array;

    cloud.writeAppearance(0, 12, 0.25, 4);
    cloud.writeAppearance(1, 0.75, 1, 0.5);
    cloud.commitAppearance();

    expect(sizeAttribute.array).toBe(originalSizeArray);
    expect(Array.from(sizeAttribute.array)).toEqual([1.5, 0.75]);
    expect(Array.from(opacityAttribute.array)).toEqual([0.25, 1]);
    expect(Array.from(intensityAttribute.array)).toEqual([4, 0.5]);
    expect(typedSizeAttribute.version).toBe(1);
    expect(typedOpacityAttribute.version).toBe(1);
    expect(typedIntensityAttribute.version).toBe(1);
  });

  it('rejects empty setup and invalid writes', () => {
    expect(() => new BodyPointCloud(new Uint32Array())).toThrow(RangeError);
    const cloud = new BodyPointCloud(new Uint32Array([0xffffff]));
    expect(() => cloud.writeAppearance(1, 1, 1, 1)).toThrow(RangeError);
    expect(() => cloud.writeAppearance(0, Number.NaN, 1, 1)).toThrow(RangeError);
  });
});
