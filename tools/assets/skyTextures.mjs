import { readFile, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

import sharp from 'sharp';

import { SKY_TEXTURE_ASSETS, assetByteBudget, guideReference } from './config.mjs';
import { encodeTexture as encodeKtxTexture } from './ktx.mjs';

/** Runtime manifest category for deep-sky panoramas (T0126). */
export const SKY_MANIFEST_CATEGORY = 'sky';

/**
 * Equirectangular panoramas are sampled by direction, so a non-2:1 source would
 * silently stretch the sky. The upper bound matches the body-texture ceiling in
 * `assetIngest.mjs`; the lower bound keeps a placeholder from shipping.
 */
const MINIMUM_PANORAMA_WIDTH = 2_048;
const MAXIMUM_PANORAMA_WIDTH = 8_192;

const QUALITY_CAPS = Object.freeze([
  ['2k', 2048],
  ['1k', 1024],
]);

function isPowerOfTwo(value) {
  return Number.isInteger(value) && value > 0 && (value & (value - 1)) === 0;
}

/**
 * Validates one declared sky asset directory and returns its findings.
 *
 * Mirrors the SOURCES.md contract `assetIngest.mjs` enforces for body textures:
 * every shipped file must be named in the attribution record, so a texture can
 * never reach `public/assets` without a license trail.
 */
export async function validateSkyAsset(directory, asset) {
  const findings = [];
  let sources = '';
  try {
    sources = await readFile(join(directory, 'SOURCES.md'), 'utf8');
  } catch {
    findings.push(`${asset.id}: ${guideReference(8)} — SOURCES.md is required`);
  }

  for (const texture of asset.textures) {
    if (!texture.startsWith(`${asset.id}_`)) {
      findings.push(`${texture}: ${guideReference(1)} — sky texture must start with "${asset.id}_"`);
    }
    if (sources !== '' && !sources.includes(texture)) {
      findings.push(`${texture}: ${guideReference(8)} — texture is not listed in SOURCES.md`);
    }
    const path = join(directory, texture);
    try {
      await stat(path);
    } catch {
      findings.push(`${texture}: ${guideReference(1)} — declared sky texture is missing`);
      continue;
    }
    const metadata = await sharp(path).metadata();
    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;
    if (width !== height * 2) {
      findings.push(
        `${texture}: ${guideReference(1)} — panorama must be equirectangular 2:1; measured ${String(width)}x${String(height)}`,
      );
    }
    if (!isPowerOfTwo(width) || !isPowerOfTwo(height)) {
      findings.push(
        `${texture}: ${guideReference(1)} — panorama dimensions must be powers of two for a complete mip chain`,
      );
    }
    if (width < MINIMUM_PANORAMA_WIDTH || width > MAXIMUM_PANORAMA_WIDTH) {
      findings.push(
        `${texture}: ${guideReference(1)} — panorama width must be between ${String(MINIMUM_PANORAMA_WIDTH)} and ${String(MAXIMUM_PANORAMA_WIDTH)}; measured ${String(width)}`,
      );
    }
  }
  return findings;
}

/**
 * Encodes every declared sky panorama into the ingest staging tree and returns
 * the manifest entries to append.
 *
 * Kept out of `assetIngest.mjs` on purpose: that module's contract is "a body
 * directory holds `<id>.glb` plus its maps", and a panorama satisfies none of it.
 */
export async function ingestSkyTextures(options) {
  const skyRoot = options.skyRoot;
  const stagingRoot = options.stagingRoot;
  const encodeTexture = options.encodeTexture ?? encodeKtxTexture;
  const assets = options.assets ?? SKY_TEXTURE_ASSETS;

  const findings = [];
  const manifestAssets = [];
  for (const asset of assets) {
    const directory = join(skyRoot, asset.sourceDirectory);
    findings.push(...(await validateSkyAsset(directory, asset)));
  }
  if (findings.length > 0) {
    throw new Error(`Sky texture ingest validation failed:\n${findings.join('\n')}`);
  }

  for (const asset of assets) {
    const directory = join(skyRoot, asset.sourceDirectory);
    const files = [];
    for (const texture of asset.textures) {
      const sourcePath = join(directory, texture);
      const stem = basename(texture, extname(texture));
      const outputName = `${stem}.ktx2`;
      await encodeTexture(sourcePath, join(stagingRoot, 'textures', outputName), {
        executable: options.ktxExecutable,
      });
      files.push(`textures/${outputName}`);
      const metadata = await sharp(sourcePath).metadata();
      for (const [suffix, maximumWidth] of QUALITY_CAPS) {
        const cappedName = `${stem}_${suffix}.ktx2`;
        const width = Math.min(maximumWidth, metadata.width ?? maximumWidth);
        await encodeTexture(sourcePath, join(stagingRoot, 'textures', cappedName), {
          executable: options.ktxExecutable,
          width,
          height: width / 2,
        });
        files.push(`textures/${cappedName}`);
      }
    }
    files.sort((left, right) => left.localeCompare(right, 'en'));

    let totalBytes = 0;
    for (const file of files) {
      totalBytes += (await stat(join(stagingRoot, ...file.split('/')))).size;
    }
    const limit = assetByteBudget(SKY_MANIFEST_CATEGORY, asset.id);
    if (totalBytes > limit) {
      throw new Error(
        `${asset.id}: ${guideReference(9)} — ${totalBytes.toLocaleString('en-US')} bytes exceed ` +
          `${limit.toLocaleString('en-US')} byte budget`,
      );
    }

    manifestAssets.push({
      id: asset.id,
      category: SKY_MANIFEST_CATEGORY,
      triangles: 0,
      files,
    });
  }
  return manifestAssets;
}
