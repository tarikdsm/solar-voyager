import { createHash } from 'node:crypto';
import { readFile, readdir, rm, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';

import { parseGlbJson } from './glb.mjs';
import { ingestAssets } from './ingest.mjs';

const KTX2_IDENTIFIER = Buffer.from([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]);
const EARTH_BUDGET_BYTES = 20 * 1024 * 1024;

async function hashTree(root) {
  const hashes = new Map();
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else hashes.set(
        relative(root, path).replaceAll('\\', '/'),
        createHash('sha256').update(await readFile(path)).digest('hex'),
      );
    }
  }
  await visit(root);
  return hashes;
}

function requireEqualHashes(first, second) {
  if (first.size !== second.size) throw new Error('Earth ingest emitted a different file count on rerun');
  for (const [path, hash] of first) {
    if (second.get(path) !== hash) throw new Error(`Earth ingest is not idempotent: ${path} changed`);
  }
}

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const outputRoot = resolve(repositoryRoot, 'build', 'assets-verify', 'earth');
const options = {
  modelsRoot: resolve(repositoryRoot, 'assets', 'models'),
  outputRoot,
  onlyIds: ['earth'],
  ...(process.env.KTX_BIN === undefined ? {} : { ktxExecutable: process.env.KTX_BIN }),
};

await rm(outputRoot, { force: true, recursive: true });
await ingestAssets(options);
const firstHashes = await hashTree(outputRoot);

const glbJson = parseGlbJson(await readFile(join(outputRoot, 'models', 'earth.glb')));
if (!(glbJson.extensionsRequired ?? []).includes('KHR_draco_mesh_compression')) {
  throw new Error('Earth runtime GLB is missing required Draco compression');
}
if (!(glbJson.extensionsRequired ?? []).includes('KHR_texture_basisu')) {
  throw new Error('Earth runtime GLB is missing required KTX2 texture bindings');
}
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'draco3d.decoder': await draco3d.createDecoderModule() });
const document = await io.read(join(outputRoot, 'models', 'earth.glb'));
const materials = new Map(document.getRoot().listMaterials().map((material) => [material.getName(), material]));
const surface = materials.get('mat_surface');
const clouds = materials.get('mat_clouds');
if (
  surface?.getBaseColorTexture()?.getURI() !== '../textures/earth_albedo.ktx2' ||
  surface.getNormalTexture()?.getURI() !== '../textures/earth_normal.ktx2' ||
  surface.getEmissiveTexture()?.getURI() !== '../textures/earth_emissive_night.ktx2' ||
  clouds?.getBaseColorTexture()?.getURI() !== '../textures/earth_clouds.ktx2'
) {
  throw new Error('Earth decoded materials do not reference the expected runtime KTX2 textures');
}
for (const texture of (await readdir(join(outputRoot, 'textures'))).sort()) {
  const bytes = await readFile(join(outputRoot, 'textures', texture));
  if (!bytes.subarray(0, KTX2_IDENTIFIER.length).equals(KTX2_IDENTIFIER)) {
    throw new Error(`${texture} is not a KTX2 file`);
  }
  if (bytes.readUInt32LE(40) <= 1) {
    throw new Error(`${texture} does not contain a complete mip chain`);
  }
}

let totalBytes = 0;
for (const path of firstHashes.keys()) totalBytes += (await stat(join(outputRoot, ...path.split('/')))).size;
if (totalBytes > EARTH_BUDGET_BYTES) {
  throw new Error(`Earth output exceeds hero budget: ${totalBytes} bytes`);
}

await ingestAssets(options);
requireEqualHashes(firstHashes, await hashTree(outputRoot));
console.log(`Earth verified: ${totalBytes.toLocaleString('en-US')} bytes; ${firstHashes.size} byte-identical files`);
