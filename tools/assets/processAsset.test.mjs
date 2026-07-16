import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { parseGlbJson } from './glb.mjs';
import { compressGlb } from './processAsset.mjs';
import { createGlb } from './testFixtures.mjs';

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    force: true,
    recursive: true,
  })));
});

describe('asset processing', () => {
  it('Draco-compresses meshes with the ingest extension', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'solar-voyager-process-'));
    temporaryDirectories.push(directory);
    const input = join(directory, 'earth.glb');
    const output = join(directory, 'compressed.glb');
    await writeFile(input, createGlb());

    await compressGlb(input, output);

    const json = parseGlbJson(await readFile(output));
    expect(json.extensionsRequired).toContain('KHR_draco_mesh_compression');
    expect(json.meshes[0].primitives[0].extensions.KHR_draco_mesh_compression).toBeDefined();
    expect((await readFile(output)).length).toBeGreaterThan(0);
  });
});
