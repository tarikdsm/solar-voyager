import { describe, expect, it } from 'vitest';

import {
  detailHeightField,
  mergeDerivedSources,
  normalPixelsFromHeight,
} from './prepareMoonMaps.mjs';

function gradientEnergy(values, width, height) {
  let x = 0;
  let y = 0;
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const index = row * width + column;
      const right = row * width + ((column + 1) % width);
      const below = ((row + 1) % height) * width + column;
      x += (values[right] - values[index]) ** 2;
      y += (values[below] - values[index]) ** 2;
    }
  }
  return { x, y };
}

describe('Moon texture preparation', () => {
  it('generates deterministic periodic and approximately isotropic detail', () => {
    const first = detailHeightField(64, 301);
    const second = detailHeightField(64, 301);
    expect(first).toEqual(second);
    const energy = gradientEnergy(first, 64, 64);
    expect(energy.x / energy.y).toBeGreaterThan(0.75);
    expect(energy.x / energy.y).toBeLessThan(1.25);
  });

  it('maps a flat height field to tangent-space neutral normals', () => {
    const pixels = normalPixelsFromHeight(new Float32Array(32).fill(0.5), 8, 4, 1);
    for (let index = 0; index < pixels.length; index += 3) {
      expect(pixels[index]).toBe(128);
      expect(pixels[index + 1]).toBe(128);
      expect(pixels[index + 2]).toBe(255);
    }
  });

  it('publishes complete and idempotent provenance for every derived map', () => {
    const first = mergeDerivedSources('# Texture sources — moon\n', 301);
    const second = mergeDerivedSources(first, 301);
    expect(second).toBe(first);
    for (const filename of [
      'moon_normal.png',
      'moon_detail_albedo.jpg',
      'moon_detail_normal.png',
    ]) {
      expect(first).toContain(filename);
    }
    expect(first).toContain('tools/textures/prepareMoonMaps.mjs');
    expect(first).toContain('seed 301');
    expect(first).toContain('all rights reserved');
  });
});
