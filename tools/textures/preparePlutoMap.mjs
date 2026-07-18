import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import sharp from 'sharp';


const DEFAULT_SEED = 999;
const DEFAULT_NO_DATA_LUMA = 20;
const POLAR_RING_FRACTION = 1 / 20;
const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DEFAULT_SOURCE = join(
  REPOSITORY_ROOT,
  'assets',
  'textures-src',
  'pluto',
  'PIA11707_pluto_color_map.jpg',
);
const DEFAULT_OUTPUT_DIRECTORY = dirname(DEFAULT_SOURCE);
const OUTPUTS = Object.freeze([
  Object.freeze({ filename: '2k_pluto.jpg', height: 1024, width: 2048 }),
  Object.freeze({ filename: '4k_pluto.jpg', height: 2048, width: 4096 }),
]);


function assertImage(input, width, height, channels) {
  if (!(input instanceof Uint8Array)) throw new TypeError('Pluto pixels must be a Uint8Array');
  if (!Number.isInteger(width) || width < 2 || !Number.isInteger(height) || height < 2) {
    throw new RangeError('Pluto map dimensions must be integers >= 2');
  }
  if (channels !== 3) throw new RangeError('Pluto reconstruction requires three RGB channels');
  if (input.byteLength !== width * height * channels) {
    throw new RangeError('Pluto pixel byte length does not match its dimensions');
  }
}


function luma(input, offset) {
  return ((input[offset] ?? 0) + (input[offset + 1] ?? 0) + (input[offset + 2] ?? 0)) / 3;
}


function bottomConnectedNoData(input, width, height, channels, threshold) {
  const count = width * height;
  const mask = new Uint8Array(count);
  const queue = new Int32Array(count);
  let head = 0;
  let tail = 0;

  function enqueue(index) {
    if (mask[index] !== 0 || luma(input, index * channels) > threshold) return;
    mask[index] = 1;
    queue[tail] = index;
    tail += 1;
  }

  for (let x = 0; x < width; x += 1) enqueue((height - 1) * width + x);
  while (head < tail) {
    const index = queue[head];
    head += 1;
    const x = index % width;
    const y = Math.floor(index / width);
    if (x > 0) enqueue(index - 1);
    if (x + 1 < width) enqueue(index + 1);
    if (y > 0) enqueue(index - width);
    if (y + 1 < height) enqueue(index + width);
  }
  if (tail < width) throw new Error('Pluto map has no bottom-connected southern no-data region');
  return mask;
}


function clampByte(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}


function smoothstep(value) {
  return value * value * (3 - 2 * value);
}


function noiseLattice(x, y, z, seed) {
  let hash =
    (seed ^
      Math.imul(x, 0x9e3779b1) ^
      Math.imul(y, 0x85ebca77) ^
      Math.imul(z, 0xc2b2ae3d)) >>>
    0;
  hash = Math.imul(hash ^ (hash >>> 16), 0x7feb352d) >>> 0;
  hash = Math.imul(hash ^ (hash >>> 15), 0x846ca68b) >>> 0;
  return ((hash ^ (hash >>> 16)) >>> 0) / 0x7fffffff - 1;
}


function valueNoise3d(x, y, z, scale, seed) {
  const gridX = x * scale + scale;
  const gridY = y * scale + scale;
  const gridZ = z * scale + scale;
  const x0 = Math.floor(gridX);
  const y0 = Math.floor(gridY);
  const z0 = Math.floor(gridZ);
  const x1 = x0 + 1;
  const y1 = y0 + 1;
  const z1 = z0 + 1;
  const tx = smoothstep(gridX - x0);
  const ty = smoothstep(gridY - y0);
  const tz = smoothstep(gridZ - z0);
  const x00 = noiseLattice(x0, y0, z0, seed) * (1 - tx) + noiseLattice(x1, y0, z0, seed) * tx;
  const x10 = noiseLattice(x0, y1, z0, seed) * (1 - tx) + noiseLattice(x1, y1, z0, seed) * tx;
  const x01 = noiseLattice(x0, y0, z1, seed) * (1 - tx) + noiseLattice(x1, y0, z1, seed) * tx;
  const x11 = noiseLattice(x0, y1, z1, seed) * (1 - tx) + noiseLattice(x1, y1, z1, seed) * tx;
  const bottom = x00 * (1 - ty) + x10 * ty;
  const top = x01 * (1 - ty) + x11 * ty;
  return bottom * (1 - tz) + top * tz;
}


function sphericalNoise(x, y, z, seed) {
  return (
    valueNoise3d(x, y, z, 2, seed) * 0.4 +
    valueNoise3d(x, y, z, 4, seed + 1) * 0.25 +
    valueNoise3d(x, y, z, 8, seed + 2) * 0.16 +
    valueNoise3d(x, y, z, 16, seed + 3) * 0.1 +
    valueNoise3d(x, y, z, 32, seed + 4) * 0.06 +
    valueNoise3d(x, y, z, 64, seed + 5) * 0.03
  );
}


function boxBlurRgb(input, width, height, radius) {
  const horizontal = new Uint8Array(input.length);
  const output = new Uint8Array(input.length);
  const diameter = radius * 2 + 1;
  for (let y = 0; y < height; y += 1) {
    for (let channel = 0; channel < 3; channel += 1) {
      let sum = 0;
      for (let delta = -radius; delta <= radius; delta += 1) {
        const x = (delta + width) % width;
        sum += input[(y * width + x) * 3 + channel] ?? 0;
      }
      for (let x = 0; x < width; x += 1) {
        horizontal[(y * width + x) * 3 + channel] = Math.round(sum / diameter);
        const leavingX = (x - radius + width) % width;
        const enteringX = (x + radius + 1) % width;
        sum -= input[(y * width + leavingX) * 3 + channel] ?? 0;
        sum += input[(y * width + enteringX) * 3 + channel] ?? 0;
      }
    }
  }
  for (let x = 0; x < width; x += 1) {
    for (let channel = 0; channel < 3; channel += 1) {
      let sum = 0;
      let count = 0;
      for (let y = 0; y < Math.min(height, radius + 1); y += 1) {
        sum += horizontal[(y * width + x) * 3 + channel] ?? 0;
        count += 1;
      }
      for (let y = 0; y < height; y += 1) {
        output[(y * width + x) * 3 + channel] = Math.round(sum / count);
        const leavingY = y - radius;
        const enteringY = y + radius + 1;
        if (leavingY >= 0) {
          sum -= horizontal[(leavingY * width + x) * 3 + channel] ?? 0;
          count -= 1;
        }
        if (enteringY < height) {
          sum += horizontal[(enteringY * width + x) * 3 + channel] ?? 0;
          count += 1;
        }
      }
    }
  }
  return output;
}


/** Reconstruct the black PIA11707 south mask plus its narrow acquisition edge. */
export function fillMissingSouth(input, width, height, options = {}) {
  const channels = options.channels ?? 3;
  const threshold = options.noDataLuma ?? DEFAULT_NO_DATA_LUMA;
  const seed = options.seed ?? DEFAULT_SEED;
  assertImage(input, width, height, channels);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 255) {
    throw new RangeError('Pluto no-data luminance threshold must be in [0, 255]');
  }
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new RangeError('Pluto reconstruction seed must be an unsigned 32-bit integer');
  }

  const noData = bottomConnectedNoData(input, width, height, channels, threshold);
  const output = Uint8Array.from(input);
  const boundaryRows = new Int32Array(width);
  const anchors = new Float64Array(width * channels);

  for (let x = 0; x < width; x += 1) {
    let boundary = height - 1;
    while (boundary >= 0 && noData[boundary * width + x] !== 0) boundary -= 1;
    if (boundary < 0) throw new Error(`Pluto no-data mask covers longitude column ${x}`);
    boundaryRows[x] = boundary;
  }
  const rawBoundaries = Int32Array.from(boundaryRows);
  const boundaryRadius = Math.max(2, Math.round(width / 256));
  const boundaryInset = Math.max(1, Math.round(height * 0.012));
  for (let x = 0; x < width; x += 1) {
    let localMinimum = height - 1;
    for (let delta = -boundaryRadius; delta <= boundaryRadius; delta += 1) {
      localMinimum = Math.min(
        localMinimum,
        rawBoundaries[(x + delta + width) % width] ?? height - 1,
      );
    }
    boundaryRows[x] = Math.max(0, localMinimum - boundaryInset);
  }

  const smoothingRadius = Math.max(2, Math.round(width / 64));
  for (let x = 0; x < width; x += 1) {
    let samples = 0;
    for (let delta = -smoothingRadius; delta <= smoothingRadius; delta += 1) {
      const sampleX = (x + delta + width) % width;
      const offset = (boundaryRows[sampleX] * width + sampleX) * channels;
      for (let channel = 0; channel < channels; channel += 1) {
        anchors[x * channels + channel] += input[offset + channel] ?? 0;
      }
      samples += 1;
    }
    for (let channel = 0; channel < channels; channel += 1) {
      anchors[x * channels + channel] /= samples;
    }
  }

  const pole = new Float64Array(channels);
  for (let x = 0; x < width; x += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      pole[channel] += anchors[x * channels + channel] / width;
    }
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixelIndex = y * width + x;
      const boundary = boundaryRows[x];
      if (y <= boundary) continue;
      const edgeBlend = smoothstep(Math.min(1, (y - boundary) / (height * 0.12)));
      const latitude = Math.PI * (0.5 - y / (height - 1));
      const longitude = Math.PI * 2 * (x / width - 0.5);
      const radial = Math.cos(latitude);
      const sphereX = radial * Math.cos(longitude);
      const sphereY = Math.sin(latitude);
      const sphereZ = radial * Math.sin(longitude);
      const luminanceNoise = sphericalNoise(sphereX, sphereY, sphereZ, seed);
      const colorNoise = sphericalNoise(sphereX, sphereY, sphereZ, seed + 17);
      const polarBrightness = smoothstep(Math.max(0, (y / (height - 1) - 0.62) / 0.38));
      const offset = pixelIndex * channels;
      for (let channel = 0; channel < channels; channel += 1) {
        const anchor = anchors[x * channels + channel];
        const base = anchor * (1 - edgeBlend) + pole[channel] * edgeBlend;
        const channelTint = channel === 0 ? colorNoise * 0.075 : colorNoise * -0.038;
        output[offset + channel] = clampByte(
          base * (0.86 + luminanceNoise * 0.7 + polarBrightness * 0.1 + channelTint),
        );
      }
    }
  }
  const feather = Math.max(2, Math.round(height * 0.055));
  const blurRadius = Math.max(1, Math.round(feather * 0.72));
  const blurred = boxBlurRgb(output, width, height, blurRadius);
  const noDataRgb = new Uint8Array(output.length);
  for (let index = 0; index < noData.length; index += 1) {
    const value = noData[index] === 0 ? 0 : 255;
    const offset = index * channels;
    noDataRgb[offset] = value;
    noDataRgb[offset + 1] = value;
    noDataRgb[offset + 2] = value;
  }
  const transitionMask = boxBlurRgb(noDataRgb, width, height, feather);
  const southernHalf = Math.floor(height * 0.5);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixelIndex = y * width + x;
      const offset = pixelIndex * channels;
      if (
        y >= southernHalf &&
        y <= boundaryRows[x] &&
        luma(input, offset) <= threshold
      ) {
        for (let channel = 0; channel < channels; channel += 1) {
          output[offset + channel] = blurred[offset + channel] ?? 0;
        }
      }
      const coverage = (transitionMask[offset] ?? 0) / 255;
      const blend = smoothstep(Math.min(1, Math.min(coverage, 1 - coverage) * 4)) * 0.94;
      if (blend <= 0) continue;
      for (let channel = 0; channel < channels; channel += 1) {
        output[offset + channel] = clampByte(
          (output[offset + channel] ?? 0) * (1 - blend) +
            (blurred[offset + channel] ?? 0) * blend,
        );
      }
    }
  }
  const poleRows = Math.max(2, Math.ceil(height * POLAR_RING_FRACTION));
  const poleFeatherRows = Math.max(poleRows + 1, Math.ceil(height * 0.085));
  const poleStart = height - poleRows;
  const poleFeatherStart = height - poleFeatherRows;
  for (let y = poleFeatherStart; y < height; y += 1) {
    const rowMean = new Float64Array(channels);
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * channels;
      for (let channel = 0; channel < channels; channel += 1) {
        rowMean[channel] += (output[offset + channel] ?? 0) / width;
      }
    }
    const blend = smoothstep(
      Math.max(0, Math.min(1, (y - poleFeatherStart) / (poleStart - poleFeatherStart))),
    );
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * channels;
      for (let channel = 0; channel < channels; channel += 1) {
        output[offset + channel] = clampByte(
          (output[offset + channel] ?? 0) * (1 - blend) +
            (rowMean[channel] ?? 0) * blend,
        );
      }
    }
  }
  return output;
}


export async function preparePlutoMaps(options = {}) {
  const source = resolve(options.source ?? DEFAULT_SOURCE);
  const outputDirectory = resolve(options.outputDirectory ?? DEFAULT_OUTPUT_DIRECTORY);
  const seed = options.seed ?? DEFAULT_SEED;
  await mkdir(outputDirectory, { recursive: true });
  const manifest = [];
  for (const target of OUTPUTS) {
    const { data, info } = await sharp(source)
      .resize(target.width, target.height, { fit: 'fill', kernel: sharp.kernel.lanczos3 })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const reconstructed = fillMissingSouth(data, info.width, info.height, {
      channels: info.channels,
      seed,
    });
    const output = join(outputDirectory, target.filename);
    await sharp(reconstructed, {
      raw: { channels: info.channels, height: info.height, width: info.width },
    })
      .jpeg({ chromaSubsampling: '4:4:4', mozjpeg: true, quality: 92 })
      .toFile(output);
    manifest.push({ file: target.filename, height: target.height, width: target.width });
  }
  return manifest;
}


function parseArguments(arguments_) {
  const options = {};
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    const value = arguments_[index + 1];
    if (argument === '--source' && value !== undefined) {
      options.source = value;
      index += 1;
    } else if (argument === '--output-dir' && value !== undefined) {
      options.outputDirectory = value;
      index += 1;
    } else {
      throw new Error(`Unknown or incomplete argument: ${argument}`);
    }
  }
  return options;
}


if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const manifest = await preparePlutoMaps(parseArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify({ seed: DEFAULT_SEED, outputs: manifest })}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
