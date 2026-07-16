import { access, readFile, readdir } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

import sharp from 'sharp';

import {
  CATEGORY_CONFIG,
  NORMALIZED_RADIUS_TOLERANCE,
  ORIGIN_TOLERANCE,
  guideReference,
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

function inspectRawContract(json, file, findings) {
  for (const image of json.images ?? []) {
    if (image.bufferView !== undefined || String(image.uri ?? '').startsWith('data:')) {
      findings.push(finding(file, 2, 'embedded texture is forbidden; deliver an external JPEG or PNG'));
      break;
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
    if (width === 0 || height === 0 || width > 8192 || height > 4096) {
      findings.push(finding(entry.name, 5, `unsupported texture dimensions ${width}×${height}`));
    }
    const isRing = entry.name.toLowerCase().includes('ring');
    const isDetail = entry.name.toLowerCase().includes('detail');
    if (!isRing && !isDetail && width !== height * 2) {
      findings.push(finding(entry.name, 5, `equirectangular texture must have 2:1 aspect; measured ${width}×${height}`));
    }
  }
  return entries.map((entry) => entry.name);
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

  try {
    inspectRawContract(await readGlbJson(glbPath), glbFile, findings);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    findings.push(finding(glbFile, 2, message));
    return { findings, triangles: 0 };
  }

  let measurement;
  try {
    measurement = measureDocument(await readGlbDocument(glbPath), identity.id);
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
  if (measurement.triangles > config.triangleLimit) {
    findings.push(
      finding(
        glbFile,
        4,
        `${measurement.triangles.toLocaleString('en-US')} triangles exceed the ${config.triangleLimit.toLocaleString('en-US')} limit`,
      ),
    );
  }

  let textures = [];
  try {
    if (hasSources && !(await readFile(sourcesPath, 'utf8')).includes(glbFile)) {
      findings.push(finding(glbFile, 8, `${glbFile} is not listed in SOURCES.md`));
    }
    textures = await inspectTextures(
      directory,
      identity.id,
      hasSources ? await readFile(sourcesPath, 'utf8') : '',
      findings,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    findings.push(finding(glbFile, 5, `could not inspect textures: ${message}`));
  }

  return { findings, triangles: measurement.triangles, file: basename(glbPath), textures };
}

export async function discoverAssets(modelsRoot) {
  const assets = [];
  const categories = Object.keys(CATEGORY_CONFIG).sort((left, right) => left.localeCompare(right, 'en'));
  for (const category of categories) {
    const categoryPath = join(modelsRoot, category);
    if (!(await exists(categoryPath))) continue;
    const singletonGlb = join(categoryPath, `${category}.glb`);
    if ((category === 'ship' || category === 'sun') && await exists(singletonGlb)) {
      assets.push({ category, directory: categoryPath, id: category });
      continue;
    }
    const entries = await readdir(categoryPath, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      if (entry.isDirectory()) {
        assets.push({ category, directory: join(categoryPath, entry.name), id: entry.name });
      }
    }
  }
  return assets;
}
