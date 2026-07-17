import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';

import { discoverAssets, validateAssetDirectory } from './assetIngest.mjs';
import { triangleLimitFor } from './config.mjs';
import { createGlb } from './testFixtures.mjs';

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    force: true,
    recursive: true,
  })));
});

async function createAssetDirectory(id = 'earth', category = 'planets') {
  const root = await mkdtemp(join(tmpdir(), 'solar-voyager-ingest-'));
  temporaryDirectories.push(root);
  const directory = category === 'ship'
    ? join(root, 'assets', 'models', 'ship')
    : join(root, 'assets', 'models', category, id);
  await mkdir(directory, { recursive: true });
  return directory;
}

describe('asset ingest validation', () => {
  it('reports every required guide section for the violating fixture', async () => {
    const directory = await createAssetDirectory();
    await writeFile(join(directory, 'earth.glb'), createGlb({ embeddedImage: true, radius: 2 }));

    const result = await validateAssetDirectory(directory, { category: 'planets', id: 'earth' });
    const diagnostics = result.findings.join('\n');

    expect(diagnostics).toContain('earth.glb');
    expect(diagnostics).toContain('MODELING-GUIDE.md §2');
    expect(diagnostics).toContain('embedded texture');
    expect(diagnostics).toContain('MODELING-GUIDE.md §3');
    expect(diagnostics).toContain('radius');
    expect(diagnostics).toContain('MODELING-GUIDE.md §8');
    expect(diagnostics).toContain('SOURCES.md');
    expect(diagnostics).toContain('detail_albedo 1k tiling map is required');
  });

  it('accepts a centered unit-radius celestial fixture', async () => {
    const directory = await createAssetDirectory('sun');
    await writeFile(join(directory, 'sun.glb'), createGlb({ radius: 1 }));
    await writeFile(join(directory, 'SOURCES.md'), '# Sources\n- sun.glb — fixture\n');

    const result = await validateAssetDirectory(directory, { category: 'sun', id: 'sun' });

    expect(result.findings).toEqual([]);
    expect(result.triangles).toBe(8);
  });

  it('rejects a root rotation that breaks the +Y-up pole contract', async () => {
    const directory = await createAssetDirectory('venus');
    await writeFile(join(directory, 'venus.glb'), createGlb({
      rootMatrix: [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    }));
    await writeFile(join(directory, 'SOURCES.md'), '- venus.glb — fixture\n');

    const result = await validateAssetDirectory(directory, { category: 'planets', id: 'venus' });

    expect(result.findings.join('\n')).toContain('primary body transform must preserve the +Y-up');
  });

  it('rejects a rotated ancestor even when the primary local transform is identity', async () => {
    const directory = await createAssetDirectory('venus');
    await writeFile(join(directory, 'venus.glb'), createGlb({
      nodeName: 'venus',
      parentMatrix: [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    }));
    await writeFile(join(directory, 'SOURCES.md'), '- venus.glb — fixture\n');

    const result = await validateAssetDirectory(directory, { category: 'planets', id: 'venus' });

    expect(result.findings.join('\n')).toContain('primary body transform must preserve the +Y-up');
  });

  it('rejects a ship whose authored nose is not aligned to local +X', async () => {
    const directory = await createAssetDirectory('ship', 'ship');
    await writeFile(join(directory, 'ship.glb'), createGlb({
      namedNodes: [
        { name: 'hull_tip', translation: [0, 0, -12] },
        { name: 'engine_nozzle', translation: [0, 0, 11.5] },
      ],
    }));
    await writeFile(join(directory, 'SOURCES.md'), '- ship.glb — fixture\n');

    const result = await validateAssetDirectory(directory, { category: 'ship', id: 'ship' });

    expect(result.findings.join('\n')).toContain('ship nose must align with local +X');
  });

  it('reports normal format, aspect ratio, and missing attribution', async () => {
    const directory = await createAssetDirectory('jupiter');
    await writeFile(join(directory, 'jupiter.glb'), createGlb());
    await sharp({ create: { width: 7, height: 4, channels: 3, background: '#8080ff' } })
      .jpeg()
      .toFile(join(directory, 'jupiter_normal.jpg'));
    await writeFile(join(directory, 'SOURCES.md'), '- jupiter.glb — fixture\n');
    await writeFile(join(directory, 'notes.txt'), 'not an approved deliverable');

    const result = await validateAssetDirectory(directory, { category: 'planets', id: 'jupiter' });
    const diagnostics = result.findings.join('\n');

    expect(diagnostics).toContain('MODELING-GUIDE.md §2 — normal maps must use PNG');
    expect(diagnostics).toContain('MODELING-GUIDE.md §5 — equirectangular texture must have 2:1 aspect');
    expect(diagnostics).toContain('MODELING-GUIDE.md §8 — texture is not listed in SOURCES.md');
    expect(diagnostics).toContain('MODELING-GUIDE.md §1 — unapproved deliverable');
  });

  it('enforces major-moon 4k albedo and required 2k normal tiers', async () => {
    const directory = await createAssetDirectory('io');
    await writeFile(join(directory, 'io.glb'), createGlb());
    await sharp({ create: { width: 2, height: 1, channels: 3, background: '#aa8855' } })
      .jpeg()
      .toFile(join(directory, 'io_albedo.jpg'));
    await writeFile(join(directory, 'SOURCES.md'), '- io.glb — fixture\n- io_albedo.jpg — fixture\n');

    const result = await validateAssetDirectory(directory, { category: 'moons', id: 'io' });
    const diagnostics = result.findings.join('\n');
    expect(diagnostics).toContain('albedo must be 4096×2048');
    expect(diagnostics).toContain('major-moon normal map is required');
  });

  it('accepts the startup Moon 4k/2k plus 1k detail tier', async () => {
    const directory = await createAssetDirectory('moon');
    await writeFile(join(directory, 'moon.glb'), createGlb());
    const textures = [
      ['moon_albedo.jpg', 4096, 2048, 'jpeg'],
      ['moon_normal.png', 2048, 1024, 'png'],
      ['moon_detail_albedo.jpg', 1024, 1024, 'jpeg'],
      ['moon_detail_normal.png', 1024, 1024, 'png'],
    ];
    for (const [name, width, height, format] of textures) {
      await sharp({ create: { width, height, channels: 3, background: '#8080ff' } })
        .toFormat(format)
        .toFile(join(directory, name));
    }
    await writeFile(
      join(directory, 'SOURCES.md'),
      ['- moon.glb — fixture', ...textures.map(([name]) => `- ${name} — fixture`), ''].join('\n'),
    );

    const result = await validateAssetDirectory(directory, { category: 'moons', id: 'moon' });
    expect(result.findings).toEqual([]);
  });

  it('allows major-moon meshes without raising ordinary moon limits', () => {
    expect(triangleLimitFor('moons', 'moon')).toBe(50_000);
    expect(triangleLimitFor('moons', 'io')).toBe(50_000);
    expect(triangleLimitFor('moons', 'phobos')).toBe(15_000);
  });

  it('rejects unknown categories, invalid catalog ids, and duplicate flattened ids', async () => {
    const root = await mkdtemp(join(tmpdir(), 'solar-voyager-discovery-'));
    temporaryDirectories.push(root);
    await mkdir(join(root, 'unknown', 'earth'), { recursive: true });
    await expect(discoverAssets(root)).rejects.toThrow('unknown source category');
    await rm(join(root, 'unknown'), { recursive: true });
    await mkdir(join(root, 'planets', 'Earth'), { recursive: true });
    await expect(discoverAssets(root)).rejects.toThrow('lowercase catalog slug');
    await rm(join(root, 'planets'), { recursive: true });
    await mkdir(join(root, 'planets', 'not-a-body'), { recursive: true });
    await expect(discoverAssets(root)).rejects.toThrow('not present in data/bodies.json');
    await rm(join(root, 'planets'), { recursive: true });
    await mkdir(join(root, 'planets', 'pluto'), { recursive: true });
    await expect(discoverAssets(root)).rejects.toThrow('does not belong in category "planets"');
    await rm(join(root, 'planets'), { recursive: true });
    await mkdir(join(root, 'planets', 'earth'), { recursive: true });
    await mkdir(join(root, 'rings', 'earth'), { recursive: true });
    await expect(discoverAssets(root)).rejects.toThrow('duplicate asset id "earth"');
  });
});
