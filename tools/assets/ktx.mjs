import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import sharp from 'sharp';

const execFileAsync = promisify(execFile);

function textureFormat(channels, normal) {
  const suffix = normal ? 'UNORM' : 'SRGB';
  if (channels === 1) return `R8_${suffix}`;
  if (channels === 2) return `R8G8_${suffix}`;
  if (channels === 4) return `R8G8B8A8_${suffix}`;
  return `R8G8B8_${suffix}`;
}

export function isNormalTexture(path) {
  return /(^|[_-])normal([_.-]|$)/i.test(path);
}

export function isLinearTexture(path) {
  return /(^|[_-])(normal|roughness|orm|metallic|ao|occlusion)([_.-]|$)/i.test(path);
}

export function buildKtxArguments(inputPath, outputPath, metadata, options = {}) {
  const normal = isNormalTexture(inputPath);
  const linear = isLinearTexture(inputPath);
  const usesFourKilopixelTier = /(^|[_-])(clouds?|emissive)([_.-]|$)/i.test(inputPath);
  const usesMoonStartupAlbedo = /(^|[/\\])moon_albedo\.(jpe?g|png)$/i.test(inputPath);
  const args = [
    'create',
    '--format', textureFormat(metadata.channels ?? 4, linear),
    '--encode', normal ? 'uastc' : 'basis-lz',
    '--generate-mipmap',
    '--assign-tf', linear ? 'linear' : 'srgb',
    '--assign-primaries', linear ? 'none' : 'bt709',
  ];
  if (options.width !== undefined && options.height !== undefined) {
    args.push('--width', String(options.width), '--height', String(options.height));
  } else if (usesFourKilopixelTier && (metadata.width ?? 0) > 4096) {
    args.push('--width', '4096', '--height', '2048');
  }
  if (usesMoonStartupAlbedo) args.push('--qlevel', '90');
  if (normal) {
    args.push(
      '--normal-mode', '--normalize', '--uastc-rdo', '--uastc-rdo-l', '0.5',
      '--uastc-rdo-m', '--zstd', '18',
    );
  }
  args.push('--threads', '1', '--testrun', inputPath, outputPath);
  return args;
}

async function defaultRunner(executable, args) {
  return execFileAsync(executable, args, { maxBuffer: 10 * 1024 * 1024 });
}

export async function encodeTexture(inputPath, outputPath, options = {}) {
  const executable = options.executable ?? process.env.KTX_BIN ?? 'ktx';
  const metadata = options.metadata ?? await sharp(inputPath).metadata();
  const run = options.run ?? defaultRunner;
  try {
    return await run(
      executable,
      buildKtxArguments(inputPath, outputPath, metadata, {
        ...(options.width !== undefined ? { width: options.width } : {}),
        ...(options.height !== undefined ? { height: options.height } : {}),
      }),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `KTX-Software 4.4.x is required (${executable}). Set KTX_BIN to ktx executable: ${message}`,
    );
  }
}
