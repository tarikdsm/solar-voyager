import { createHash } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import {
  TEXTURE_FILENAMES,
  TEXTURE_HEIGHT,
  TEXTURE_WIDTH,
  generateAlbedo,
  generateEmissive,
  generateMetallicRoughness,
  generateNormal,
  heightAt,
  panelAt,
  writeShipTexture,
} from './generateShipTextures.mjs';

function sample(bytes, x, y) {
  const offset = (y * TEXTURE_WIDTH + x) * 3;
  return [bytes[offset], bytes[offset + 1], bytes[offset + 2]];
}

function meanChannel(bytes, channel, y0, y1) {
  let total = 0;
  let count = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = 0; x < TEXTURE_WIDTH; x += 16) {
      total += bytes[(y * TEXTURE_WIDTH + x) * 3 + channel];
      count += 1;
    }
  }
  return total / count;
}

describe('ship texture dimensions', () => {
  it('authors at the 2048x1024 tier the task specifies', () => {
    expect(TEXTURE_WIDTH).toBe(2048);
    expect(TEXTURE_HEIGHT).toBe(1024);
    expect(TEXTURE_WIDTH).toBe(TEXTURE_HEIGHT * 2);
  });

  it('names exactly the four maps the builder copies, sorted', () => {
    expect([...TEXTURE_FILENAMES]).toEqual([
      'ship_mat_engine_glow__emissive.png',
      'ship_mat_hull__albedo.png',
      'ship_mat_hull__metallic.png',
      'ship_mat_hull__normal.png',
    ]);
    expect([...TEXTURE_FILENAMES]).toEqual([...TEXTURE_FILENAMES].sort());
    for (const name of TEXTURE_FILENAMES) {
      expect(name.startsWith('ship_')).toBe(true);
      expect(name.endsWith('.png')).toBe(true);
    }
  });
});

describe('panel layout', () => {
  it('tiles the map without gaps or overlaps', () => {
    for (const [x, y] of [
      [0, 0],
      [255, 63],
      [256, 64],
      [1023, 511],
      [2047, 1023],
      [717, 349],
    ]) {
      const panel = panelAt(x, y);
      expect(x).toBeGreaterThanOrEqual(panel.minX);
      expect(x).toBeLessThan(panel.maxX);
      expect(y).toBeGreaterThanOrEqual(panel.minY);
      expect(y).toBeLessThan(panel.maxY);
    }
  });

  it('produces more than one panel size', () => {
    const sizes = new Set();
    for (let bay = 0; bay < 8; bay += 1) {
      for (let row = 0; row < 16; row += 1) {
        const panel = panelAt(bay * 256 + 4, row * 64 + 4);
        sizes.add(`${String(panel.maxX - panel.minX)}x${String(panel.maxY - panel.minY)}`);
      }
    }
    expect(sizes.size).toBeGreaterThan(1);
  });

  it('is a pure function of its coordinates', () => {
    expect(panelAt(913, 407)).toEqual(panelAt(913, 407));
    expect(heightAt(913, 407)).toBe(heightAt(913, 407));
  });

  it('cuts a groove at every panel edge', () => {
    const panel = panelAt(600, 300);
    expect(heightAt(panel.minX, 300)).toBeLessThan(heightAt(panel.minX + 12, 300));
  });
});

describe('hull maps', () => {
  const albedo = generateAlbedo();
  const normal = generateNormal();
  const metallic = generateMetallicRoughness();

  it('fills every byte of each buffer', () => {
    for (const buffer of [albedo, normal, metallic]) {
      expect(buffer.length).toBe(TEXTURE_WIDTH * TEXTURE_HEIGHT * 3);
    }
  });

  it('keeps the albedo inside a plausible spacecraft-hull range', () => {
    let minimum = 255;
    let maximum = 0;
    for (let index = 0; index < albedo.length; index += 3) {
      minimum = Math.min(minimum, albedo[index]);
      maximum = Math.max(maximum, albedo[index]);
    }
    expect(minimum).toBeGreaterThan(8);
    expect(maximum).toBeLessThan(230);
  });

  /**
   * U is the hull circumference, so column 2047 is adjacent to column 0. The
   * seam is a panel boundary like any other: the bay grid must divide the width
   * exactly, the groove must straddle the wrap, and the normal map's horizontal
   * derivative must be taken through the wrap rather than clamped at the edge.
   * Raw pixel equality across the seam would be the wrong test — two different
   * plates meet there, exactly as they do at every other panel boundary.
   */
  it('lands a whole number of panel bays on the circumference', () => {
    const first = panelAt(0, 300);
    const last = panelAt(TEXTURE_WIDTH - 1, 300);
    expect(first.minX).toBe(0);
    expect(last.maxX).toBe(TEXTURE_WIDTH);
  });

  it('carves the seam groove across the wrap', () => {
    for (let y = 4; y < TEXTURE_HEIGHT; y += 97) {
      expect(heightAt(0, y)).toBeLessThan(heightAt(10, y));
      expect(heightAt(TEXTURE_WIDTH - 1, y)).toBeLessThan(heightAt(TEXTURE_WIDTH - 11, y));
    }
  });

  it('differentiates the normal map through the wrap, not against a clamped edge', () => {
    const tilt = (x) => {
      let total = 0;
      for (let y = 0; y < TEXTURE_HEIGHT; y += 1) total += Math.abs(sample(normal, x, y)[0] - 128);
      return total / TEXTURE_HEIGHT;
    };
    // A clamped edge would reuse column 0 as its own left neighbour and leave
    // the seam columns visibly flatter than the identical interior bay
    // boundary at x = 255/256.
    const seam = (tilt(0) + tilt(TEXTURE_WIDTH - 1)) / 2;
    const interior = (tilt(256) + tilt(255)) / 2;
    expect(interior).toBeGreaterThan(10);
    expect(seam).toBeGreaterThan(interior * 0.6);
  });

  it('points the normal map outward everywhere', () => {
    for (let index = 0; index < normal.length; index += 3 * 4093) {
      expect(normal[index + 2]).toBeGreaterThan(128);
    }
  });

  it('keeps normals unit length after decoding', () => {
    for (let index = 0; index < normal.length; index += 3 * 7919) {
      const x = (normal[index] / 255) * 2 - 1;
      const y = (normal[index + 1] / 255) * 2 - 1;
      const z = (normal[index + 2] / 255) * 2 - 1;
      expect(Math.hypot(x, y, z)).toBeCloseTo(1, 1);
    }
  });

  it('holds the metallic-roughness red channel at 1.0, since red is occlusion', () => {
    for (let index = 0; index < metallic.length; index += 3 * 5011) {
      expect(metallic[index]).toBe(255);
    }
  });

  it('keeps most of the hull metallic', () => {
    expect(meanChannel(metallic, 2, 0, TEXTURE_HEIGHT)).toBeGreaterThan(150);
  });

  /**
   * Blender maps V = 0 to the tail and its glTF exporter writes
   * v_gltf = 1 - v_blender, whose origin is the top row. Row 0 is therefore the
   * nose and the last row is the tail. If this flips, the engine soot lands on
   * the nose cone.
   */
  it('puts the engine soot on the tail rows, not the nose rows', () => {
    const nose = meanChannel(albedo, 1, 0, 64);
    const tail = meanChannel(albedo, 1, TEXTURE_HEIGHT - 64, TEXTURE_HEIGHT);
    expect(tail).toBeLessThan(nose * 0.8);
  });

  it('roughens the sooted tail rows', () => {
    const nose = meanChannel(metallic, 1, 0, 64);
    const tail = meanChannel(metallic, 1, TEXTURE_HEIGHT - 64, TEXTURE_HEIGHT);
    expect(tail).toBeGreaterThan(nose);
  });
});

describe('engine glow map', () => {
  const emissive = generateEmissive();

  it('is brightest at U = 0, the throat centre', () => {
    const core = sample(emissive, 0, 512);
    const rim = sample(emissive, TEXTURE_WIDTH - 1, 512);
    expect(core[0] + core[1] + core[2]).toBeGreaterThan(rim[0] + rim[1] + rim[2]);
  });

  it('stays a cyan ladder rather than a white disc', () => {
    const mid = sample(emissive, 700, 200);
    expect(mid[2]).toBeGreaterThan(mid[0]);
  });

  it('never clips a channel below zero or above 255', () => {
    for (let index = 0; index < emissive.length; index += 3 * 3001) {
      for (let channel = 0; channel < 3; channel += 1) {
        expect(emissive[index + channel]).toBeGreaterThanOrEqual(0);
        expect(emissive[index + channel]).toBeLessThanOrEqual(255);
      }
    }
  });
});

describe('determinism', () => {
  it('produces identical buffers on repeated evaluation', () => {
    expect(createHash('sha256').update(generateAlbedo()).digest('hex')).toBe(
      createHash('sha256').update(generateAlbedo()).digest('hex'),
    );
    expect(createHash('sha256').update(generateNormal()).digest('hex')).toBe(
      createHash('sha256').update(generateNormal()).digest('hex'),
    );
  }, 60_000);

  it('writes byte-identical PNGs on repeated runs', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ship-textures-'));
    const first = join(directory, 'a.png');
    const second = join(directory, 'b.png');
    await writeShipTexture('ship_mat_engine_glow__emissive.png', first);
    await writeShipTexture('ship_mat_engine_glow__emissive.png', second);
    expect(await readFile(first)).toEqual(await readFile(second));
    const metadata = await sharp(first).metadata();
    expect(metadata.width).toBe(TEXTURE_WIDTH);
    expect(metadata.height).toBe(TEXTURE_HEIGHT);
    expect(metadata.format).toBe('png');
  }, 60_000);

  it('rejects an unknown map name', async () => {
    await expect(writeShipTexture('ship_nope.png', join(tmpdir(), 'nope.png'))).rejects.toThrow(
      RangeError,
    );
  });
});
