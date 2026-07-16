import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

const SIZE = 1024;
const TAU = Math.PI * 2;

function field(x, y, phase) {
  const u = (x / SIZE) * TAU;
  const v = (y / SIZE) * TAU;
  return (
    0.55 * Math.sin(u * 3 + Math.cos(v * 2 + phase) + phase) +
    0.3 * Math.sin(v * 5 - Math.cos(u * 4 - phase)) +
    0.15 * Math.sin((u + v) * 11 + phase * 2)
  );
}

function generateAlbedo(phase) {
  const bytes = Buffer.alloc(SIZE * SIZE * 3);
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const value = Math.max(0, Math.min(255, Math.round(128 + field(x, y, phase) * 38)));
      const offset = (y * SIZE + x) * 3;
      bytes[offset] = value;
      bytes[offset + 1] = value;
      bytes[offset + 2] = value;
    }
  }
  return bytes;
}

function generateNormal(phase) {
  const bytes = Buffer.alloc(SIZE * SIZE * 3);
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const dx = field((x + 1) % SIZE, y, phase) - field((x + SIZE - 1) % SIZE, y, phase);
      const dy = field(x, (y + 1) % SIZE, phase) - field(x, (y + SIZE - 1) % SIZE, phase);
      const inverseLength = 1 / Math.hypot(dx * 18, dy * 18, 1);
      const offset = (y * SIZE + x) * 3;
      bytes[offset] = Math.round((-dx * 18 * inverseLength * 0.5 + 0.5) * 255);
      bytes[offset + 1] = Math.round((-dy * 18 * inverseLength * 0.5 + 0.5) * 255);
      bytes[offset + 2] = Math.round((inverseLength * 0.5 + 0.5) * 255);
    }
  }
  return bytes;
}

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const assets = [
  { category: 'planets', id: 'earth', phase: 0.3 },
  { category: 'planets', id: 'saturn', phase: 1.7 },
  { category: 'dwarfs', id: 'pluto', phase: 3.1 },
];

for (const asset of assets) {
  const directory = resolve(repositoryRoot, 'assets', 'models', asset.category, asset.id);
  await sharp(generateAlbedo(asset.phase), { raw: { width: SIZE, height: SIZE, channels: 3 } })
    .jpeg({ chromaSubsampling: '4:4:4', quality: 90 })
    .toFile(resolve(directory, `${asset.id}_detail_albedo.jpg`));
  await sharp(generateNormal(asset.phase), { raw: { width: SIZE, height: SIZE, channels: 3 } })
    .png({ compressionLevel: 9 })
    .toFile(resolve(directory, `${asset.id}_detail_normal.png`));
}

console.log(`Generated deterministic ${SIZE}×${SIZE} detail pairs for ${assets.length} bodies.`);
