import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';

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

function parseTextureRole(role) {
  const separator = role.indexOf('__');
  if (separator < 1 || separator === role.length - 2) {
    return { materialName: null, semanticRole: role };
  }
  return {
    materialName: role.slice(0, separator),
    semanticRole: role.slice(separator + 2),
  };
}

function materialForRole(document, role) {
  const materials = document.getRoot().listMaterials();
  const parsed = parseTextureRole(role);
  if (parsed.materialName !== null) {
    const material = materials.find((candidate) => candidate.getName() === parsed.materialName);
    if (material === undefined) {
      throw new Error(`Texture role "${role}" targets missing material "${parsed.materialName}"`);
    }
    return { material, semanticRole: parsed.semanticRole };
  }
  const targetName = role === 'clouds' ? 'mat_clouds' : role === 'rings' ? 'mat_rings' : 'mat_surface';
  return {
    material: materials.find((material) => material.getName() === targetName) ?? materials[0] ?? null,
    semanticRole: parsed.semanticRole,
  };
}

function attachTexture(document, binding) {
  const marker = `runtime:${binding.role}:${binding.sourceName}`;
  const texture = document.getRoot().listTextures()
    .find((candidate) => basename(candidate.getURI()) === binding.sourceName) ?? document.createTexture();
  texture
    .setName(marker)
    .setImage(null)
    .setURI(binding.uri)
    .setMimeType('image/ktx2');
  const { material, semanticRole } = materialForRole(document, binding.role);
  if (material === null) return;
  if (semanticRole === 'normal') material.setNormalTexture(texture);
  else if (semanticRole === 'emissive') material.setEmissiveTexture(texture);
  else if (['roughness', 'orm', 'metallic'].includes(semanticRole)) {
    material.setMetallicRoughnessTexture(texture);
  } else if (['ao', 'occlusion'].includes(semanticRole)) material.setOcclusionTexture(texture);
  else if (['albedo', 'clouds', 'rings'].includes(semanticRole)) material.setBaseColorTexture(texture);
  else {
    const extras = material.getExtras();
    material.setExtras({
      ...extras,
      solarVoyagerTextures: {
        ...(typeof extras.solarVoyagerTextures === 'object' && extras.solarVoyagerTextures !== null
          ? extras.solarVoyagerTextures
          : {}),
        [semanticRole]: binding.uri,
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
    for (const binding of options.textures) {
      const marker = `runtime:${binding.role}:${binding.sourceName}`;
      const image = json.images.find((candidate) => candidate.name === marker);
      if (image === undefined) throw new Error(`Runtime texture image not emitted for ${binding.sourceName}`);
      image.uri = binding.uri;
      delete image.bufferView;
    }
    await writeFile(outputPath, replaceGlbJson(bytes, json));
  }
}
