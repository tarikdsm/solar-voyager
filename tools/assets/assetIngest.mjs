import { access, readFile, readdir } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

import sharp from 'sharp';

import {
  CATEGORY_CONFIG,
  HERO_IDS,
  MAJOR_MOON_IDS,
  NORMALIZED_RADIUS_TOLERANCE,
  ORIGIN_TOLERANCE,
  guideReference,
  triangleLimitFor,
} from './config.mjs';
import { measureDocument, readGlbDocument, readGlbJson } from './glb.mjs';

function finding(file, section, message) {
  return `${file}: ${guideReference(section)} — ${message}`;
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

async function inspectRawContract(json, file, directory, findings) {
  for (const image of json.images ?? []) {
    if (image.bufferView !== undefined || String(image.uri ?? '').startsWith('data:')) {
      findings.push(finding(file, 2, 'embedded texture is forbidden; deliver an external JPEG or PNG'));
      break;
    }
    if (typeof image.uri === 'string') {
      const imageExtension = extname(image.uri).toLowerCase();
      if (basename(image.uri) !== image.uri || !['.jpg', '.jpeg', '.png'].includes(imageExtension)) {
        findings.push(finding(file, 2, `external texture URI "${image.uri}" must name a local JPEG or PNG`));
      } else if (!(await exists(join(directory, image.uri)))) {
        findings.push(finding(file, 2, `external texture URI "${image.uri}" does not exist`));
      }
    }
  }
  if ((json.cameras?.length ?? 0) > 0) {
    findings.push(finding(file, 2, 'cameras are forbidden in authored GLBs'));
  }
  if ((json.animations?.length ?? 0) > 0) {
    findings.push(finding(file, 2, 'animations are forbidden in authored GLBs'));
  }
  if ((json.extensionsUsed ?? []).includes('KHR_lights_punctual')) {
    findings.push(finding(file, 2, 'lights are forbidden in authored GLBs'));
  }
  if ((json.extensionsUsed ?? []).includes('KHR_draco_mesh_compression')) {
    findings.push(finding(file, 2, 'Draco compression belongs to ingest, not authoring'));
  }
}

async function inspectTextures(directory, id, sources, findings) {
  const entries = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && ['.jpg', '.jpeg', '.png'].includes(extname(entry.name).toLowerCase()))
    .sort((left, right) => left.name.localeCompare(right.name, 'en'));

  const textures = [];
  for (const entry of entries) {
    const extension = extname(entry.name).toLowerCase();
    if (!entry.name.startsWith(`${id}_`)) {
      findings.push(finding(entry.name, 1, `texture name must start with "${id}_"`));
    }
    if (entry.name.toLowerCase().includes('normal') && extension !== '.png') {
      findings.push(finding(entry.name, 2, 'normal maps must use PNG'));
    }
    if (!sources.includes(entry.name)) {
      findings.push(finding(entry.name, 8, 'texture is not listed in SOURCES.md'));
    }

    const metadata = await sharp(join(directory, entry.name)).metadata();
    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;
    const role = entry.name.slice(id.length + 1, -extension.length);
    textures.push({ name: entry.name, extension, height, role, width });
    if (width === 0 || height === 0 || width > 8192 || height > 4096) {
      findings.push(finding(entry.name, 5, `unsupported texture dimensions ${width}×${height}`));
    }
    const isRing = entry.name.toLowerCase().includes('ring');
    const isDetail = entry.name.toLowerCase().includes('detail');
    if (!isRing && !isDetail && width !== height * 2) {
      findings.push(finding(entry.name, 5, `equirectangular texture must have 2:1 aspect; measured ${width}×${height}`));
    }
  }
  return textures;
}

function validateDimensions(texture, width, height, findings) {
  if (texture.width !== width || texture.height !== height) {
    findings.push(
      finding(texture.name, 5, `${texture.role} must be ${width}×${height}; measured ${texture.width}×${texture.height}`),
    );
  }
}

function validateTextureTier(textures, identity, findings) {
  const byRole = new Map(textures.map((texture) => [texture.role, texture]));
  const requiresSurface = ['planets', 'moons', 'dwarfs', 'asteroids', 'comets'].includes(identity.category);
  const albedo = byRole.get('albedo');
  if (requiresSurface && albedo === undefined) {
    findings.push(finding(`${identity.id}.glb`, 5, `${identity.id}_albedo texture is required`));
  }

  if (identity.id === 'moon') {
    if (albedo !== undefined) validateDimensions(albedo, 4096, 2048, findings);
    const normal = byRole.get('normal');
    if (normal === undefined) findings.push(finding(`${identity.id}.glb`, 5, 'Moon normal map is required'));
    else validateDimensions(normal, 2048, 1024, findings);
  } else if (HERO_IDS.has(identity.id)) {
    if (albedo !== undefined) validateDimensions(albedo, 8192, 4096, findings);
    const normal = byRole.get('normal');
    if (normal === undefined) findings.push(finding(`${identity.id}.glb`, 5, 'hero normal map is required'));
    else validateDimensions(normal, 4096, 2048, findings);
  } else if (identity.category === 'planets') {
    if (albedo !== undefined) validateDimensions(albedo, 4096, 2048, findings);
    const normal = byRole.get('normal');
    if (normal !== undefined) validateDimensions(normal, 2048, 1024, findings);
  } else if (identity.category === 'moons') {
    const normal = byRole.get('normal');
    if (MAJOR_MOON_IDS.has(identity.id)) {
      if (albedo !== undefined) validateDimensions(albedo, 4096, 2048, findings);
      if (normal === undefined) findings.push(finding(`${identity.id}.glb`, 5, 'major-moon normal map is required'));
      else validateDimensions(normal, 2048, 1024, findings);
    } else if (
      albedo !== undefined &&
      (albedo.width < 1024 || albedo.width > 2048 || albedo.height * 2 !== albedo.width)
    ) {
      findings.push(finding(albedo.name, 5, `small-moon albedo must be 1k–2k at 2:1; measured ${albedo.width}×${albedo.height}`));
    }
  } else if (['dwarfs', 'asteroids', 'comets'].includes(identity.category) && albedo !== undefined) {
    if (albedo.width < 1024 || albedo.width > 2048 || albedo.height * 2 !== albedo.width) {
      findings.push(finding(albedo.name, 5, `small-body albedo must be 1k–2k at 2:1; measured ${albedo.width}×${albedo.height}`));
    }
  }

  if (['planets', 'moons', 'dwarfs'].includes(identity.category)) {
    for (const role of ['detail_albedo', 'detail_normal']) {
      const detail = byRole.get(role);
      if (detail === undefined) findings.push(finding(`${identity.id}.glb`, 5, `${role} 1k tiling map is required`));
      else validateDimensions(detail, 1024, 1024, findings);
    }
  }

  for (const texture of textures.filter((item) => item.role.includes('rings'))) {
    if (texture.width < 2048 || texture.height < 64) {
      findings.push(finding(texture.name, 5, `ring strip must be at least 2048×64; measured ${texture.width}×${texture.height}`));
    }
  }
}

function validateShipAxis(document, file, findings) {
  const nodes = document.getRoot().listNodes();
  const tip = nodes.find((node) => node.getName() === 'hull_tip');
  const nozzle = nodes.find((node) => node.getName() === 'engine_nozzle');
  if (tip === undefined || nozzle === undefined) {
    findings.push(finding(file, 3, 'ship requires named hull_tip and engine_nozzle nodes'));
    return;
  }
  const tipMatrix = tip.getWorldMatrix();
  const nozzleMatrix = nozzle.getWorldMatrix();
  const delta = [
    tipMatrix[12] - nozzleMatrix[12],
    tipMatrix[13] - nozzleMatrix[13],
    tipMatrix[14] - nozzleMatrix[14],
  ];
  const length = Math.hypot(...delta);
  if (length <= 1e-6 || delta[0] / length < 0.999) {
    findings.push(
      finding(
        file,
        3,
        `ship nose must align with local +X; hull_tip - engine_nozzle measured [${delta
          .map((value) => value.toFixed(6)).join(', ')}]`,
      ),
    );
  }
}

export async function validateAssetDirectory(directory, identity) {
  const findings = [];
  const config = CATEGORY_CONFIG[identity.category];
  const glbFile = `${identity.id}.glb`;
  const glbPath = join(directory, glbFile);

  if (config === undefined) {
    return { findings: [finding(glbFile, 1, `unknown category "${identity.category}"`)], triangles: 0 };
  }
  const sourcesPath = join(directory, 'SOURCES.md');
  const hasSources = await exists(sourcesPath);
  if (!hasSources) {
    findings.push(finding(glbFile, 8, 'SOURCES.md is required'));
  }
  if (!(await exists(glbPath))) {
    findings.push(finding(glbFile, 1, `expected deliverable ${glbFile}`));
    return { findings, triangles: 0 };
  }
  const deliverables = await readdir(directory, { withFileTypes: true });
  for (const entry of deliverables) {
    const extension = extname(entry.name).toLowerCase();
    const approved = entry.isFile() && (
      entry.name === glbFile || entry.name === 'SOURCES.md' || entry.name === '.gitkeep' ||
      (entry.name.startsWith(`${identity.id}_`) && ['.jpg', '.jpeg', '.png'].includes(extension))
    );
    if (!approved) findings.push(finding(entry.name, 1, 'unapproved deliverable in asset directory'));
  }

  try {
    await inspectRawContract(await readGlbJson(glbPath), glbFile, directory, findings);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    findings.push(finding(glbFile, 2, message));
    return { findings, triangles: 0 };
  }

  let document;
  let measurement;
  try {
    document = await readGlbDocument(glbPath);
    measurement = measureDocument(document, identity.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    findings.push(finding(glbFile, 2, `could not decode GLB: ${message}`));
    return { findings, triangles: 0 };
  }

  if (config.normalizedBody !== false) {
    if (!measurement.primaryTransformIdentity) {
      findings.push(finding(glbFile, 3, 'primary body transform must preserve the +Y-up authoring frame'));
    }
    if (Math.abs(measurement.radius - 1) > NORMALIZED_RADIUS_TOLERANCE) {
      findings.push(
        finding(
          glbFile,
          3,
          `radius must be 1.0 ± ${NORMALIZED_RADIUS_TOLERANCE}; measured ${measurement.radius.toFixed(6)}`,
        ),
      );
    }
    if (measurement.center.some((component) => Math.abs(component) > ORIGIN_TOLERANCE)) {
      findings.push(
        finding(
          glbFile,
          3,
          `origin must be centered; measured [${measurement.center.map((value) => value.toFixed(6)).join(', ')}]`,
        ),
      );
    }
  }
  if (identity.category === 'ship') validateShipAxis(document, glbFile, findings);
  const triangleLimit = triangleLimitFor(identity.category, identity.id);
  if (measurement.triangles > triangleLimit) {
    findings.push(
      finding(
        glbFile,
        4,
        `${measurement.triangles.toLocaleString('en-US')} triangles exceed the ${triangleLimit.toLocaleString('en-US')} limit`,
      ),
    );
  }

  let textures = [];
  try {
    if (hasSources && !(await readFile(sourcesPath, 'utf8')).includes(glbFile)) {
      findings.push(finding(glbFile, 8, `${glbFile} is not listed in SOURCES.md`));
    }
    const textureMetadata = await inspectTextures(
      directory,
      identity.id,
      hasSources ? await readFile(sourcesPath, 'utf8') : '',
      findings,
    );
    validateTextureTier(textureMetadata, identity, findings);
    textures = textureMetadata.map((texture) => texture.name);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    findings.push(finding(glbFile, 5, `could not inspect textures: ${message}`));
  }

  return { findings, triangles: measurement.triangles, file: basename(glbPath), textures };
}

export async function discoverAssets(modelsRoot) {
  const assets = [];
  const categories = Object.keys(CATEGORY_CONFIG).sort((left, right) => left.localeCompare(right, 'en'));
  const topLevel = await readdir(modelsRoot, { withFileTypes: true });
  const allowedTopLevel = new Set([...categories, '_shared-detail']);
  for (const entry of topLevel) {
    if (entry.isDirectory() && !allowedTopLevel.has(entry.name)) {
      throw new Error(`${guideReference(1)} — unknown source category "${entry.name}"`);
    }
  }
  const catalog = JSON.parse(await readFile(new URL('../../data/bodies.json', import.meta.url), 'utf8'));
  const catalogKinds = new Map(catalog.bodies.map((body) => [body.id, body.kind]));
  const expectedKinds = {
    asteroids: 'asteroid',
    comets: 'comet',
    dwarfs: 'dwarf',
    moons: 'moon',
    planets: 'planet',
    sun: 'star',
  };
  const seenIds = new Set();
  function addAsset(category, directory, id) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
      throw new Error(`${guideReference(1)} — asset id "${id}" must be a lowercase catalog slug`);
    }
    if (id !== 'ship' && !catalogKinds.has(id)) {
      throw new Error(`${guideReference(1)} — asset id "${id}" is not present in data/bodies.json`);
    }
    const expectedKind = expectedKinds[category];
    if (expectedKind !== undefined && catalogKinds.get(id) !== expectedKind) {
      throw new Error(`${guideReference(1)} — asset "${id}" does not belong in category "${category}"`);
    }
    if (seenIds.has(id)) {
      throw new Error(`${guideReference(1)} — duplicate asset id "${id}" would overwrite runtime output`);
    }
    seenIds.add(id);
    assets.push({ category, directory, id });
  }
  for (const category of categories) {
    const categoryPath = join(modelsRoot, category);
    if (!(await exists(categoryPath))) continue;
    const singletonGlb = join(categoryPath, `${category}.glb`);
    if ((category === 'ship' || category === 'sun') && await exists(singletonGlb)) {
      addAsset(category, categoryPath, category);
      continue;
    }
    const entries = await readdir(categoryPath, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      if (entry.isDirectory()) {
        addAsset(category, join(categoryPath, entry.name), entry.name);
      }
    }
  }
  return assets;
}
