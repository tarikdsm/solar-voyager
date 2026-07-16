import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { draco } from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';

export const DRACO_OPTIONS = Object.freeze({
  quantizeNormal: 10,
  quantizePosition: 14,
  quantizeTexcoord: 12,
});

export async function compressGlb(inputPath, outputPath) {
  const encoder = await draco3d.createEncoderModule();
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'draco3d.encoder': encoder });
  const document = await io.read(inputPath);
  await document.transform(draco(DRACO_OPTIONS));
  await mkdir(dirname(outputPath), { recursive: true });
  await io.write(outputPath, document);
}

