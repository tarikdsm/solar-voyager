import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import sharp from 'sharp';

const TAU = Math.PI * 2;

function field(x, y, size, phase) {
  const u = (x / size) * TAU;
  const v = (y / size) * TAU;
  return (
    0.62 * Math.sin(v * 7 + 0.45 * Math.sin(u * 3 + phase)) +
    0.25 * Math.sin(v * 19 - u * 2 + phase * 1.7) +
    0.13 * Math.sin((u + v) * 31 + phase * 2.3)
  );
}

export function generateGasDetailPair(seed, size = 1024) {
  if (!Number.isInteger(seed) || seed < 0 || !Number.isInteger(size) || size < 4) {
    throw new RangeError('Gas detail generation requires a nonnegative seed and size >= 4.');
  }
  const phase = (seed % 6283) / 1000;
  const albedo = Buffer.alloc(size * size * 3);
  const normal = Buffer.alloc(size * size * 3);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const value = field(x, y, size, phase);
      const dx = field((x + 1) % size, y, size, phase) - field((x + size - 1) % size, y, size, phase);
      const dy = field(x, (y + 1) % size, size, phase) - field(x, (y + size - 1) % size, size, phase);
      const inverseLength = 1 / Math.hypot(dx * 12, dy * 12, 1);
      const offset = (y * size + x) * 3;
      const luminance = Math.max(0, Math.min(255, Math.round(128 + value * 30)));
      albedo[offset] = luminance;
      albedo[offset + 1] = luminance;
      albedo[offset + 2] = luminance;
      normal[offset] = Math.round((-dx * 12 * inverseLength * 0.5 + 0.5) * 255);
      normal[offset + 1] = Math.round((-dy * 12 * inverseLength * 0.5 + 0.5) * 255);
      normal[offset + 2] = Math.round((inverseLength * 0.5 + 0.5) * 255);
    }
  }
  return Object.freeze({ albedo, normal });
}

async function main(argv) {
  const bodyIndex = argv.indexOf('--body');
  const seedIndex = argv.indexOf('--seed');
  const outputIndex = argv.indexOf('--output');
  const bodyId = argv[bodyIndex + 1];
  const seed = Number(argv[seedIndex + 1]);
  const output = argv[outputIndex + 1];
  if (bodyIndex < 0 || seedIndex < 0 || outputIndex < 0 || !bodyId || !output) {
    throw new Error('Usage: generateGasDetailTextures.mjs --body <id> --seed <n> --output <dir>');
  }
  const size = 1024;
  const pair = generateGasDetailPair(seed, size);
  await mkdir(output, { recursive: true });
  await sharp(pair.albedo, { raw: { width: size, height: size, channels: 3 } })
    .jpeg({ quality: 90, chromaSubsampling: '4:4:4' })
    .toFile(resolve(output, `${bodyId}_detail_albedo.jpg`));
  await sharp(pair.normal, { raw: { width: size, height: size, channels: 3 } })
    .png({ compressionLevel: 9, adaptiveFiltering: false })
    .toFile(resolve(output, `${bodyId}_detail_normal.png`));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
