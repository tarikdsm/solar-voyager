/**
 * Deterministic authored PBR maps for the Solar Voyager ship (T0121).
 *
 * The ship is not a photographed body, so there is no upstream image to fetch:
 * these four maps are authored procedurally and this file is their source of
 * truth. It writes into `assets/textures-src/ship/`; `tools/blender/build_ship.py`
 * copies the same bytes into `assets/models/ship/` and wires them as external
 * images, and `npm run assets:ingest` encodes them to KTX2.
 *
 * UV contract (must match `tools/blender/ship_geometry.py`):
 *   - `mat_hull` maps: U is the hull circumference (8 bays of 256 px), V is the
 *     axial station from tail (0) to nose (1). At the 2.1 m hull radius one bay
 *     is 1.65 m wide and one 64 px row is 1.41 m long, so the panel grid is
 *     close to square on the real hull.
 *   - `mat_engine_glow` emissive: U is the radial fraction of the glow disc
 *     (0 at the throat centre, 1 at the rim), V is the angular fraction.
 *
 * Every value comes from an integer hash of its own pixel/panel coordinates, so
 * the output is byte-identical on any machine and independent of iteration
 * order. Nothing here reads `Math.random` or the clock.
 */
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import sharp from 'sharp';

export const TEXTURE_WIDTH = 2048;
export const TEXTURE_HEIGHT = 1024;

/** Bays around the hull circumference; 2048 / 8 = 256 px each. */
const BAY_WIDTH = 256;
/** Axial panel rows; 1024 / 16 = 64 px each. */
const BAY_HEIGHT = 64;
/** Every fourth row boundary is a structural bulkhead frame. */
const BULKHEAD_PERIOD = 4;

const SEED_LAYOUT = 0x5_1a7;
const SEED_PANEL = 0x9_e37;
const SEED_SURFACE = 0x1_c69;

/** Central-difference gain that turns the height field into tangent normals. */
const NORMAL_STRENGTH = 2.6;

export const TEXTURE_FILENAMES = Object.freeze([
  'ship_mat_engine_glow__emissive.png',
  'ship_mat_hull__albedo.png',
  'ship_mat_hull__metallic.png',
  'ship_mat_hull__normal.png',
]);

function hash3(x, y, seed) {
  let value = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x85ebca6b);
  value ^= value >>> 15;
  value = Math.imul(value, 0x2c1b3c6d);
  value ^= value >>> 12;
  value = Math.imul(value, 0x297a2d39);
  value ^= value >>> 15;
  return (value >>> 0) / 4294967296;
}

function smoothstep(edge0, edge1, value) {
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function fade(t) {
  return t * t * (3 - 2 * t);
}

/** Value noise on a lattice that wraps in both axes, so U stays seamless. */
function tiledNoise(x, y, cellsX, cellsY, seed) {
  const gridX = (x / TEXTURE_WIDTH) * cellsX;
  const gridY = (y / TEXTURE_HEIGHT) * cellsY;
  const x0 = Math.floor(gridX);
  const y0 = Math.floor(gridY);
  const tx = fade(gridX - x0);
  const ty = fade(gridY - y0);
  const xa = ((x0 % cellsX) + cellsX) % cellsX;
  const xb = (xa + 1) % cellsX;
  const ya = ((y0 % cellsY) + cellsY) % cellsY;
  const yb = (ya + 1) % cellsY;
  const c00 = hash3(xa, ya, seed);
  const c10 = hash3(xb, ya, seed);
  const c01 = hash3(xa, yb, seed);
  const c11 = hash3(xb, yb, seed);
  return (c00 * (1 - tx) + c10 * tx) * (1 - ty) + (c01 * (1 - tx) + c11 * tx) * ty;
}

function fbm(x, y, cellsX, cellsY, seed, octaves) {
  let amplitude = 1;
  let total = 0;
  let normalization = 0;
  for (let octave = 0; octave < octaves; octave += 1) {
    const scale = 1 << octave;
    total += amplitude * tiledNoise(x, y, cellsX * scale, cellsY * scale, seed + octave * 733);
    normalization += amplitude;
    amplitude *= 0.5;
  }
  return total / normalization;
}

/**
 * Resolves the panel rectangle covering one pixel.
 *
 * Each 256x64 bay is split in U, in V, in both or not at all, which is what
 * produces the irregular plating that reads as a built object instead of a
 * printed grid.
 */
export function panelAt(x, y) {
  const bayX = Math.floor(x / BAY_WIDTH);
  const bayY = Math.floor(y / BAY_HEIGHT);
  const layout = hash3(bayX, bayY, SEED_LAYOUT);
  const splitU = layout < 0.3 || layout >= 0.7;
  const splitV = layout >= 0.3;
  const localX = x - bayX * BAY_WIDTH;
  const localY = y - bayY * BAY_HEIGHT;
  const halfU = splitU && localX >= BAY_WIDTH / 2 ? 1 : 0;
  const halfV = splitV && localY >= BAY_HEIGHT / 2 ? 1 : 0;
  const width = splitU ? BAY_WIDTH / 2 : BAY_WIDTH;
  const height = splitV ? BAY_HEIGHT / 2 : BAY_HEIGHT;
  const minX = bayX * BAY_WIDTH + halfU * width;
  const minY = bayY * BAY_HEIGHT + halfV * height;
  return {
    minX,
    minY,
    maxX: minX + width,
    maxY: minY + height,
    id: hash3(minX, minY, SEED_PANEL),
  };
}

/** Distance in pixels to the nearest edge of this pixel's panel. */
function edgeDistance(x, y, panel) {
  return Math.min(x - panel.minX, panel.maxX - 1 - x, y - panel.minY, panel.maxY - 1 - y);
}

/** Rivet bump amplitude; rivets sit on bay seams and on bulkhead frames. */
function rivetHeight(x, y) {
  const nearBulkhead = ((y + BAY_HEIGHT / 2) % (BAY_HEIGHT * BULKHEAD_PERIOD)) - BAY_HEIGHT / 2;
  const rowOffset = Math.abs(nearBulkhead - 5);
  if (rowOffset > 4) return 0;
  const along = ((x % 16) + 16) % 16;
  const distance = Math.hypot(along - 8, rowOffset);
  return distance > 3 ? 0 : (1 - smoothstep(1.2, 3, distance)) * 0.55;
}

/** Weld bead along the structural frames, which catch the sun as bright lines. */
function beadHeight(y) {
  const offset = ((y % (BAY_HEIGHT * BULKHEAD_PERIOD)) + BAY_HEIGHT * BULKHEAD_PERIOD) %
    (BAY_HEIGHT * BULKHEAD_PERIOD);
  const distance = Math.min(offset, BAY_HEIGHT * BULKHEAD_PERIOD - offset);
  return distance > 3 ? 0 : Math.exp(-(distance * distance) / 3.2) * 0.45;
}

/** Height field the normal map is differentiated from; also drives the albedo. */
export function heightAt(x, y) {
  const panel = panelAt(x, y);
  const distance = edgeDistance(x, y, panel);
  const groove = 1 - smoothstep(0.5, 2.6, distance);
  const plate = (panel.id - 0.5) * 0.5;
  const grain = (fbm(x, y, 32, 16, SEED_SURFACE, 4) - 0.5) * 0.22;
  return plate - groove * 1.35 + rivetHeight(x, y) + beadHeight(y) + grain;
}

/** Panel material class: painted service panels break up the bare-metal hull. */
function panelClass(panel) {
  const selector = hash3(panel.minX + 7, panel.minY + 13, SEED_PANEL);
  if (selector < 0.12) return 'painted';
  if (selector < 0.2) return 'dark';
  return 'metal';
}

/**
 * Engine soot and micrometeoroid scuffing, strongest at the aft end.
 *
 * Row orientation matters and is easy to get backwards: the builder maps
 * Blender `V = 0` to the tail, and Blender's glTF exporter writes
 * `v_gltf = 1 - v_blender`, whose origin is the *top* row of the image. Row 0 is
 * therefore the nose and the last row is the tail, so the soot belongs at the
 * bottom of the map. `tools/tests/shipTextureOrientation` in
 * `generateShipTextures.test.mjs` pins this.
 */
function wear(x, y) {
  const v = 1 - y / (TEXTURE_HEIGHT - 1);
  const aft = smoothstep(0.34, 0.02, v);
  const streak = fbm(x, y, 96, 4, SEED_SURFACE + 5077, 3);
  return Math.max(0, Math.min(1, aft * (0.45 + 0.85 * streak)));
}

function quantize(value, step) {
  return Math.max(0, Math.min(255, Math.round(Math.round(value * 255 / step) * step)));
}

export function generateAlbedo() {
  const bytes = Buffer.alloc(TEXTURE_WIDTH * TEXTURE_HEIGHT * 3);
  for (let y = 0; y < TEXTURE_HEIGHT; y += 1) {
    for (let x = 0; x < TEXTURE_WIDTH; x += 1) {
      const panel = panelAt(x, y);
      const kind = panelClass(panel);
      const distance = edgeDistance(x, y, panel);
      const groove = 1 - smoothstep(0.5, 2.4, distance);
      const variation = (panel.id - 0.5) * 0.06;
      let red;
      let green;
      let blue;
      if (kind === 'painted') {
        const base = 0.47 + variation;
        red = base * 1.06;
        green = base * 0.98;
        blue = base * 0.9;
      } else if (kind === 'dark') {
        const base = 0.3 + variation * 0.6;
        red = base;
        green = base * 1.01;
        blue = base * 1.08;
      } else {
        const base = 0.67 + variation;
        red = base * 0.98;
        green = base;
        blue = Math.min(0.84, base * 1.03);
      }
      const grain = (fbm(x, y, 64, 32, SEED_SURFACE + 91, 3) - 0.5) * 0.05;
      const soot = wear(x, y) * 0.5;
      const shade = (1 - groove * 0.24) * (1 - soot) + grain;
      const offset = (y * TEXTURE_WIDTH + x) * 3;
      bytes[offset] = quantize(red * shade, 2);
      bytes[offset + 1] = quantize(green * shade, 2);
      bytes[offset + 2] = quantize(blue * shade, 2);
    }
  }
  return bytes;
}

export function generateNormal() {
  const heights = new Float32Array(TEXTURE_WIDTH * TEXTURE_HEIGHT);
  for (let y = 0; y < TEXTURE_HEIGHT; y += 1) {
    for (let x = 0; x < TEXTURE_WIDTH; x += 1) heights[y * TEXTURE_WIDTH + x] = heightAt(x, y);
  }
  const bytes = Buffer.alloc(TEXTURE_WIDTH * TEXTURE_HEIGHT * 3);
  for (let y = 0; y < TEXTURE_HEIGHT; y += 1) {
    const rowUp = Math.max(0, y - 1) * TEXTURE_WIDTH;
    const rowDown = Math.min(TEXTURE_HEIGHT - 1, y + 1) * TEXTURE_WIDTH;
    const row = y * TEXTURE_WIDTH;
    for (let x = 0; x < TEXTURE_WIDTH; x += 1) {
      const left = (x + TEXTURE_WIDTH - 1) % TEXTURE_WIDTH;
      const right = (x + 1) % TEXTURE_WIDTH;
      const dx = (heights[row + right] - heights[row + left]) * NORMAL_STRENGTH;
      const dy = (heights[rowDown + x] - heights[rowUp + x]) * NORMAL_STRENGTH;
      const inverseLength = 1 / Math.hypot(dx, dy, 1);
      const offset = (y * TEXTURE_WIDTH + x) * 3;
      bytes[offset] = quantize(-dx * inverseLength * 0.5 + 0.5, 1);
      bytes[offset + 1] = quantize(-dy * inverseLength * 0.5 + 0.5, 1);
      bytes[offset + 2] = quantize(inverseLength * 0.5 + 0.5, 1);
    }
  }
  return bytes;
}

/**
 * glTF metallic-roughness packing: green is roughness, blue is metalness.
 *
 * Red carries the occlusion channel the glTF spec reserves for a packed ORM
 * texture; the ingest binds this file to `setMetallicRoughnessTexture`, which
 * only samples G and B, so red stays at 1.0 (no occlusion).
 */
export function generateMetallicRoughness() {
  const bytes = Buffer.alloc(TEXTURE_WIDTH * TEXTURE_HEIGHT * 3);
  for (let y = 0; y < TEXTURE_HEIGHT; y += 1) {
    for (let x = 0; x < TEXTURE_WIDTH; x += 1) {
      const panel = panelAt(x, y);
      const kind = panelClass(panel);
      const distance = edgeDistance(x, y, panel);
      const groove = 1 - smoothstep(0.5, 2.4, distance);
      const variation = (panel.id - 0.5) * 0.1;
      let roughness;
      let metallic;
      if (kind === 'painted') {
        roughness = 0.58 + variation;
        metallic = 0.12;
      } else if (kind === 'dark') {
        roughness = 0.44 + variation;
        metallic = 0.72;
      } else {
        roughness = 0.29 + variation;
        metallic = 0.92;
      }
      const grain = (fbm(x, y, 64, 32, SEED_SURFACE + 313, 3) - 0.5) * 0.07;
      const scuff = wear(x, y);
      roughness = roughness + grain + groove * 0.22 + scuff * 0.3;
      metallic = metallic - groove * 0.08 - scuff * 0.25;
      const offset = (y * TEXTURE_WIDTH + x) * 3;
      bytes[offset] = 255;
      bytes[offset + 1] = quantize(Math.max(0.05, Math.min(1, roughness)), 1);
      bytes[offset + 2] = quantize(Math.max(0, Math.min(1, metallic)), 1);
    }
  }
  return bytes;
}

/**
 * Photon-drive throat emission, mapped radially: U is the disc radius fraction.
 *
 * The colour ladder runs white-hot core -> cyan -> deep blue rim, which is what
 * the spec's "the exhaust is light" identity asks for, and stays inside sRGB so
 * the bloom pass in T0122 controls the final intensity rather than the map.
 */
export function generateEmissive() {
  const bytes = Buffer.alloc(TEXTURE_WIDTH * TEXTURE_HEIGHT * 3);
  for (let y = 0; y < TEXTURE_HEIGHT; y += 1) {
    const angle = (y / TEXTURE_HEIGHT) * Math.PI * 2;
    const spokes = 0.94 + 0.06 * Math.cos(angle * 24);
    for (let x = 0; x < TEXTURE_WIDTH; x += 1) {
      const radius = x / (TEXTURE_WIDTH - 1);
      const core = Math.exp(-(radius * radius) / 0.055);
      const shocks = 0.82 + 0.18 * Math.cos(radius * Math.PI * 2 * 5);
      const halo = (1 - smoothstep(0.55, 1, radius)) * 0.55;
      const energy = Math.max(0, Math.min(1, (core * 0.85 + halo) * shocks * spokes));
      const offset = (y * TEXTURE_WIDTH + x) * 3;
      bytes[offset] = quantize(Math.min(1, energy * energy * 1.15), 1);
      bytes[offset + 1] = quantize(Math.min(1, 0.28 + 0.72 * energy), 1);
      bytes[offset + 2] = quantize(Math.min(1, 0.42 + 0.58 * Math.sqrt(energy)), 1);
    }
  }
  return bytes;
}

const GENERATORS = Object.freeze({
  'ship_mat_engine_glow__emissive.png': generateEmissive,
  'ship_mat_hull__albedo.png': generateAlbedo,
  'ship_mat_hull__metallic.png': generateMetallicRoughness,
  'ship_mat_hull__normal.png': generateNormal,
});

export async function writeShipTexture(filename, outputPath) {
  const generator = GENERATORS[filename];
  if (generator === undefined) throw new RangeError(`Unknown ship texture ${filename}.`);
  await mkdir(dirname(resolve(outputPath)), { recursive: true });
  await sharp(generator(), {
    raw: { width: TEXTURE_WIDTH, height: TEXTURE_HEIGHT, channels: 3 },
  })
    .png({ compressionLevel: 9, adaptiveFiltering: true, palette: false })
    .toFile(outputPath);
  return outputPath;
}

export async function writeShipTextures(outputDirectory) {
  const written = [];
  for (const filename of TEXTURE_FILENAMES) {
    written.push(await writeShipTexture(filename, resolve(outputDirectory, filename)));
  }
  return written;
}

async function main(argv) {
  const outputIndex = argv.indexOf('--output');
  const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
  const outputDirectory =
    outputIndex >= 0 && argv[outputIndex + 1] !== undefined
      ? resolve(argv[outputIndex + 1])
      : resolve(repositoryRoot, 'assets', 'textures-src', 'ship');
  for (const path of await writeShipTextures(outputDirectory)) {
    console.log(`wrote ${path}`);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
