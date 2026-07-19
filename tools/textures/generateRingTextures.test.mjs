import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { generateRingTexture } from './generateRingTextures.mjs';

const SYSTEM = Object.freeze({
  bodyId: 'test',
  referenceRadiusKm: 10,
  innerRadiusKm: 11,
  outerRadiusKm: 23,
  exposure: 3,
  baseColor: '#c8b080',
  bands: Object.freeze([
    Object.freeze({
      name: 'faint',
      innerRadiusKm: 12,
      outerRadiusKm: 15,
      opticalDepth: 0.1,
      color: '#806040',
    }),
    Object.freeze({
      name: 'dense',
      innerRadiusKm: 17,
      outerRadiusKm: 21,
      opticalDepth: 1,
      color: '#f0d8a0',
    }),
  ]),
});

describe('ring texture generator', () => {
  it('writes byte-identical 2048x64 RGBA radial strips', async () => {
    const root = await mkdtemp(join(tmpdir(), 'solar-voyager-rings-'));
    const first = join(root, 'first.png');
    const second = join(root, 'second.png');
    await generateRingTexture(SYSTEM, first);
    await generateRingTexture(SYSTEM, second);

    expect(await readFile(first)).toEqual(await readFile(second));
    const { data, info } = await sharp(first).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(info).toMatchObject({ width: 2048, height: 64, channels: 4 });
    expect(data[3]).toBe(0);
    expect(data[(info.width - 1) * 4 + 3]).toBe(0);
    expect(row(data, info.width, 0)).toEqual(row(data, info.width, info.height - 1));
  });

  it('preserves optical-depth ordering without an angular seam', async () => {
    const root = await mkdtemp(join(tmpdir(), 'solar-voyager-rings-'));
    const output = join(root, 'profile.png');
    await generateRingTexture(SYSTEM, output);
    const { data, info } = await sharp(output).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const alphaAt = (radiusKm) => {
      const x = Math.round(
        ((radiusKm - SYSTEM.innerRadiusKm) / (SYSTEM.outerRadiusKm - SYSTEM.innerRadiusKm)) *
          (info.width - 1),
      );
      return data[x * 4 + 3];
    };
    expect(alphaAt(19)).toBeGreaterThan(alphaAt(13));
    expect(row(data, info.width, 1)).toEqual(row(data, info.width, info.height - 2));
  });
});

function row(data, width, y) {
  return data.subarray(y * width * 4, (y + 1) * width * 4);
}
