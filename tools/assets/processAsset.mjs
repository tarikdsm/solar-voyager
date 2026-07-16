import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRTextureBasisu } from '@gltf-transform/extensions';
import { draco } from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';

import { parseGlbJson, replaceGlbJson } from './glb.mjs';

export const DRACO_OPTIONS = Object.freeze({
  quantizeNormal: 10,
  quantizePosition: 14,
  quantizeTexcoord: 12,
});

function materialForRole(document, role) {
  const materials = document.getRoot().listMaterials();
  const targetName = role === 'clouds' ? 'mat_clouds' : role === 'rings' ? 'mat_rings' : 'mat_surface';
  return materials.find((material) => material.getName() === targetName) ?? materials[0] ?? null;
}

function attachTexture(document, binding) {
  const texture = document.createTexture(binding.role)
    .setURI(binding.uri)
    .setMimeType('image/ktx2');
  const material = materialForRole(document, binding.role);
  if (material === null) return;
  if (binding.role === 'normal') material.setNormalTexture(texture);
  else if (binding.role === 'emissive') material.setEmissiveTexture(texture);
  else if (['roughness', 'orm', 'metallic'].includes(binding.role)) {
    material.setMetallicRoughnessTexture(texture);
  } else if (['ao', 'occlusion'].includes(binding.role)) material.setOcclusionTexture(texture);
  else if (['albedo', 'clouds', 'rings'].includes(binding.role)) material.setBaseColorTexture(texture);
  else {
    const extras = material.getExtras();
    material.setExtras({
      ...extras,
      solarVoyagerTextures: {
        ...(typeof extras.solarVoyagerTextures === 'object' && extras.solarVoyagerTextures !== null
          ? extras.solarVoyagerTextures
          : {}),
        [binding.role]: binding.uri,
      },
    });
  }
}

export async function compressGlb(inputPath, outputPath, options = {}) {
  const encoder = await draco3d.createEncoderModule();
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'draco3d.encoder': encoder });
  const document = await io.read(inputPath);
  if ((options.textures?.length ?? 0) > 0) {
    document.createExtension(KHRTextureBasisu).setRequired(true);
    for (const binding of options.textures) attachTexture(document, binding);
  }
  await document.transform(draco(DRACO_OPTIONS));
  await mkdir(dirname(outputPath), { recursive: true });
  await io.write(outputPath, document);
  if ((options.textures?.length ?? 0) > 0) {
    const bytes = await readFile(outputPath);
    const json = parseGlbJson(bytes, outputPath);
    for (const [index, binding] of options.textures.entries()) {
      json.images[index].uri = binding.uri;
    }
    await writeFile(outputPath, replaceGlbJson(bytes, json));
  }
}
