import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';

import { ingestAssets } from './ingest.mjs';
import { createGlb } from './testFixtures.mjs';

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    force: true,
    recursive: true,
  })));
});

async function hashTree(root) {
  const hashes = {};
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else hashes[relative(root, path).replaceAll('\\', '/')] = createHash('sha256').update(await readFile(path)).digest('hex');
    }
  }
  await visit(root);
  return hashes;
}

async function createSourceTree() {
  const root = await mkdtemp(join(tmpdir(), 'solar-voyager-ingest-tree-'));
  temporaryDirectories.push(root);
  const modelsRoot = join(root, 'assets', 'models');
  const vesta = join(modelsRoot, 'asteroids', 'vesta');
  await mkdir(vesta, { recursive: true });
  await writeFile(join(vesta, 'vesta.glb'), createGlb());
  await sharp({ create: { width: 1024, height: 512, channels: 3, background: '#336699' } })
    .jpeg()
    .toFile(join(vesta, 'vesta_albedo.jpg'));
  await writeFile(join(vesta, 'SOURCES.md'), '- vesta.glb — fixture — test\n- vesta_albedo.jpg — fixture — test\n');
  return { modelsRoot, outputRoot: join(root, 'public', 'assets') };
}

async function fakeEncode(input, output) {
  const digest = createHash('sha256').update(await readFile(input)).digest();
  await writeFile(output, Buffer.concat([Buffer.from('«KTX 20»'), digest]));
}

describe('complete asset ingest', () => {
  it('publishes a canonical manifest and identical bytes on rerun', async () => {
    const paths = await createSourceTree();
    await ingestAssets({ ...paths, encodeTexture: fakeEncode });
    const first = await hashTree(paths.outputRoot);
    await ingestAssets({ ...paths, encodeTexture: fakeEncode });
    const second = await hashTree(paths.outputRoot);

    expect(second).toEqual(first);
    const manifest = JSON.parse(await readFile(join(paths.outputRoot, 'manifest.json'), 'utf8'));
    expect(manifest).toEqual({
      assets: [{
        category: 'asteroid',
        files: ['models/vesta.glb', 'textures/vesta_albedo.ktx2'],
        id: 'vesta',
        triangles: 8,
      }],
      schemaVersion: 1,
    });
  });

  it('preserves the prior published tree when validation fails', async () => {
    const paths = await createSourceTree();
    await mkdir(paths.outputRoot, { recursive: true });
    await writeFile(join(paths.outputRoot, 'sentinel.txt'), 'last known good');
    await rm(join(paths.modelsRoot, 'asteroids', 'vesta', 'SOURCES.md'));

    await expect(ingestAssets({ ...paths, encodeTexture: fakeEncode })).rejects.toThrow(
      'MODELING-GUIDE.md §8',
    );
    expect(await readFile(join(paths.outputRoot, 'sentinel.txt'), 'utf8')).toBe('last known good');
  });
});
