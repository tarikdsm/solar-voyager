import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { parseGlbJson } from './glb.mjs';
import { compressGlb } from './processAsset.mjs';
import { createGlb } from './testFixtures.mjs';
import sharp from 'sharp';

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

  it('wires external KTX2 textures to named runtime materials', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'solar-voyager-process-'));
    temporaryDirectories.push(directory);
    const input = join(directory, 'earth.glb');
    const output = join(directory, 'compressed.glb');
    await writeFile(input, createGlb({ materialName: 'mat_surface' }));

    await compressGlb(input, output, {
      textures: [
        { role: 'albedo', uri: '../textures/earth_albedo.ktx2' },
        { role: 'normal', uri: '../textures/earth_normal.ktx2' },
      ],
    });

    const json = parseGlbJson(await readFile(output));
    expect(json.extensionsRequired).toContain('KHR_texture_basisu');
    expect(json.images.map((image) => image.uri)).toEqual([
      '../textures/earth_albedo.ktx2', '../textures/earth_normal.ktx2',
    ]);
    expect(json.materials[0].pbrMetallicRoughness.baseColorTexture).toBeDefined();
    expect(json.materials[0].normalTexture).toBeDefined();
  });

  it('reuses authored external texture objects without retaining source bytes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'solar-voyager-process-'));
    temporaryDirectories.push(directory);
    const input = join(directory, 'earth.glb');
    const output = join(directory, 'compressed.glb');
    await sharp({ create: { width: 2, height: 2, channels: 3, background: '#336699' } })
      .png()
      .toFile(join(directory, 'earth_albedo.png'));
    await writeFile(input, createGlb({
      externalImageUri: 'earth_albedo.png', materialName: 'mat_surface',
    }));

    await compressGlb(input, output, {
      textures: [{ role: 'albedo', sourceName: 'earth_albedo.png', uri: '../textures/earth_albedo.ktx2' }],
    });

    const json = parseGlbJson(await readFile(output));
    expect(json.images).toHaveLength(1);
    expect(json.images[0].uri).toBe('../textures/earth_albedo.ktx2');
    expect(json.images[0].bufferView).toBeUndefined();
    expect(json.textures[0].extensions.KHR_texture_basisu.source).toBe(0);
    expect(json.materials[0].pbrMetallicRoughness.baseColorTexture.index).toBe(0);
  });
});
