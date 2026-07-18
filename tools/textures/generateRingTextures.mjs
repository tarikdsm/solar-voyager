import { mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import sharp from 'sharp';

const WIDTH = 2048;
const HEIGHT = 64;

function parseColor(value) {
  if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/iu.test(value)) {
    throw new RangeError(`Invalid ring color ${String(value)}.`);
  }
  return [
    Number.parseInt(value.slice(1, 3), 16),
    Number.parseInt(value.slice(3, 5), 16),
    Number.parseInt(value.slice(5, 7), 16),
  ];
}

function smoothstep(edge0, edge1, value) {
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export async function generateRingTexture(system, outputPath) {
  const span = system.outerRadiusKm - system.innerRadiusKm;
  if (!(span > 0) || !Array.isArray(system.bands) || system.bands.length === 0) {
    throw new RangeError('Ring texture system requires an increasing annulus and bands.');
  }
  const profile = Buffer.alloc(WIDTH * 4);
  const featherKm = (span / WIDTH) * 2;
  for (let x = 0; x < WIDTH; x += 1) {
    const radiusKm = system.innerRadiusKm + ((x + 0.5) / WIDTH) * span;
    let accumulatedDepth = 0;
    let weightedRed = 0;
    let weightedGreen = 0;
    let weightedBlue = 0;
    for (const band of system.bands) {
      const enter = smoothstep(band.innerRadiusKm - featherKm, band.innerRadiusKm + featherKm, radiusKm);
      const leave = 1 - smoothstep(band.outerRadiusKm - featherKm, band.outerRadiusKm + featherKm, radiusKm);
      const weight = Math.max(0, enter * leave) * band.opticalDepth;
      if (weight <= 0) continue;
      const [red, green, blue] = parseColor(band.color);
      accumulatedDepth += weight;
      weightedRed += red * weight;
      weightedGreen += green * weight;
      weightedBlue += blue * weight;
    }
    const offset = x * 4;
    if (accumulatedDepth > 0) {
      profile[offset] = Math.round(weightedRed / accumulatedDepth);
      profile[offset + 1] = Math.round(weightedGreen / accumulatedDepth);
      profile[offset + 2] = Math.round(weightedBlue / accumulatedDepth);
      profile[offset + 3] = Math.round(255 * (1 - Math.exp(-accumulatedDepth * system.exposure)));
    }
  }
  profile[3] = 0;
  profile[(WIDTH - 1) * 4 + 3] = 0;
  const pixels = Buffer.alloc(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y += 1) profile.copy(pixels, y * WIDTH * 4);
  await mkdir(dirname(resolve(outputPath)), { recursive: true });
  await sharp(pixels, { raw: { width: WIDTH, height: HEIGHT, channels: 4 } })
    .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
    .toFile(outputPath);
}

async function main(argv) {
  const bodyIndex = argv.indexOf('--body');
  const outputIndex = argv.indexOf('--output');
  if (bodyIndex < 0 || outputIndex < 0 || !argv[bodyIndex + 1] || !argv[outputIndex + 1]) {
    throw new Error('Usage: generateRingTextures.mjs --body <id> --output <path>');
  }
  const documentPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../data/rings.json');
  const document = JSON.parse(await readFile(documentPath, 'utf8'));
  const bodyId = argv[bodyIndex + 1];
  const system = document.systems.find((candidate) => candidate.bodyId === bodyId);
  if (!system) throw new Error(`Unknown ring body ${bodyId}.`);
  await generateRingTexture(system, argv[outputIndex + 1]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
