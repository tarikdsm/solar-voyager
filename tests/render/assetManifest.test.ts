import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { loadAssetManifest, parseAssetManifest } from '../../src/render/assetManifest';

describe('runtime asset manifest', () => {
  it('parses the committed generated manifest', async () => {
    const source: unknown = JSON.parse(await readFile('public/assets/manifest.json', 'utf8'));
    const manifest = parseAssetManifest(source);
    expect(manifest.assets.map((asset) => asset.id)).toEqual([
      'earth',
      'jupiter',
      'moon',
      'neptune',
      'pluto',
      'saturn',
      'ship',
      'sun',
      'uranus',
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
    expect(() => parseAssetManifest({ schemaVersion: 2, assets: [asset, asset] })).toThrow(
      /unsafe|duplicate/,
    );
  });

  it('parses strict surface-detail metadata whose textures belong to the asset', () => {
    const detailedEarth = {
      id: 'earth',
      category: 'planet',
      triangles: 1,
      files: [
        'models/earth.glb',
        'textures/earth_detail_albedo.ktx2',
        'textures/earth_detail_normal.ktx2',
      ],
      surfaceDetail: {
        albedo: 'textures/earth_detail_albedo.ktx2',
        normal: 'textures/earth_detail_normal.ktx2',
        tilesPerEquator: 512,
        seed: 399,
      },
    };

    expect(parseAssetManifest({ schemaVersion: 2, assets: [detailedEarth] }).assets[0]).toEqual(
      detailedEarth,
    );
  });

  it.each([
    ['unsafe albedo', { albedo: '../escape.ktx2' }],
    ['absent normal', { normal: 'textures/missing.ktx2' }],
    ['zero scale', { tilesPerEquator: 0 }],
    ['negative seed', { seed: -1 }],
    ['fractional seed', { seed: 1.5 }],
  ])('rejects surface detail with %s', (_label, override) => {
    const files = [
      'models/earth.glb',
      'textures/earth_detail_albedo.ktx2',
      'textures/earth_detail_normal.ktx2',
    ];
    const surfaceDetail = {
      albedo: 'textures/earth_detail_albedo.ktx2',
      normal: 'textures/earth_detail_normal.ktx2',
      tilesPerEquator: 512,
      seed: 399,
      ...override,
    };

    expect(() =>
      parseAssetManifest({
        schemaVersion: 2,
        assets: [{ id: 'earth', category: 'planet', triangles: 1, files, surfaceDetail }],
      }),
    ).toThrow(/surface detail/iu);
  });

  it('loads through an injected fetch boundary', async () => {
    const fetcher = async () => new Response(JSON.stringify({ schemaVersion: 2, assets: [] }));
    await expect(loadAssetManifest('/assets/manifest.json', fetcher)).resolves.toEqual({
      schemaVersion: 2,
      assets: [],
    });
  });
});
