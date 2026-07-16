import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { loadAssetManifest, parseAssetManifest } from '../../src/render/assetManifest';

describe('runtime asset manifest', () => {
  it('parses the committed generated manifest', async () => {
    const source: unknown = JSON.parse(await readFile('public/assets/manifest.json', 'utf8'));
    const manifest = parseAssetManifest(source);
    expect(manifest.assets.map((asset) => asset.id)).toEqual([
      'earth',
      'moon',
      'pluto',
      'saturn',
      'ship',
      'sun',
    ]);
    expect(manifest.assets.find((asset) => asset.id === 'earth')?.files).toContain(
      'models/earth.glb',
    );
    expect(manifest.assets.find((asset) => asset.id === 'earth')?.files).toContain(
      'textures/earth_albedo_tier2.ktx2',
    );
  });

  it('rejects duplicate ids and unsafe runtime paths', () => {
    const asset = { id: 'earth', category: 'planet', triangles: 1, files: ['../earth.glb'] };
    expect(() => parseAssetManifest({ schemaVersion: 1, assets: [asset, asset] })).toThrow(
      /unsafe|duplicate/,
    );
  });

  it('loads through an injected fetch boundary', async () => {
    const fetcher = async () => new Response(JSON.stringify({ schemaVersion: 1, assets: [] }));
    await expect(loadAssetManifest('/assets/manifest.json', fetcher)).resolves.toEqual({
      schemaVersion: 1,
      assets: [],
    });
  });
});
