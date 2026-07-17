import { readFile } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readGlbJson } from './glb.mjs';

const ASSET_ROOT = join(process.cwd(), 'public', 'assets');
const KTX2_IDENTIFIER = Buffer.from([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]);

function ktx2Dimensions(bytes, label) {
  expect(bytes.subarray(0, KTX2_IDENTIFIER.length), `${label} identifier`).toEqual(
    KTX2_IDENTIFIER,
  );
  return { width: bytes.readUInt32LE(20), height: bytes.readUInt32LE(24) };
}

describe('published runtime texture caps', () => {
  it('keeps every capped GLB image at or below its declared maximum dimension', async () => {
    const manifest = JSON.parse(await readFile(join(ASSET_ROOT, 'manifest.json'), 'utf8'));
    let checkedImages = 0;

    for (const asset of manifest.assets) {
      for (const [suffix, maximumDimension] of [
        ['2k', 2048],
        ['1k', 1024],
      ]) {
        const modelRelative = `models/${asset.id}_${suffix}.glb`;
        if (!asset.files.includes(modelRelative)) continue;
        const modelPath = join(ASSET_ROOT, ...modelRelative.split('/'));
        const json = await readGlbJson(modelPath);
        for (const image of json.images ?? []) {
          expect(image.uri, `${modelRelative} image URI`).toMatch(
            new RegExp(`_${suffix}\\.ktx2$`, 'u'),
          );
          const texturePath = normalize(join(dirname(modelPath), image.uri));
          const dimensions = ktx2Dimensions(await readFile(texturePath), image.uri);
          expect(Math.max(dimensions.width, dimensions.height), image.uri).toBeLessThanOrEqual(
            maximumDimension,
          );
          checkedImages += 1;
        }
      }
    }

    expect(checkedImages).toBeGreaterThanOrEqual(20);
  });
});
