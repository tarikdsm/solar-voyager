import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { chromium } from 'playwright';
import sharp from 'sharp';
import { createServer } from 'vite';

const HOST = '127.0.0.1';
const PORT = 4179;
const VIEWPORT_SIZE = 512;
const FIXTURE_URL = `http://${HOST}:${PORT}/solar-voyager/tests/render/surfaceDetail.html`;

async function pixels(buffer) {
  const { data, info } = await sharp(buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

function luminance(image, x, y) {
  const offset = (y * image.width + x) * image.channels;
  return (
    (image.data[offset] ?? 0) * 0.2126 +
    (image.data[offset + 1] ?? 0) * 0.7152 +
    (image.data[offset + 2] ?? 0) * 0.0722
  );
}

function highFrequencyEnergy(image) {
  let energy = 0;
  let samples = 0;
  for (let y = 1; y < image.height - 1; y += 1) {
    for (let x = 1; x < image.width - 1; x += 1) {
      const value = luminance(image, x, y);
      energy += Math.abs(value - luminance(image, x + 1, y));
      energy += Math.abs(value - luminance(image, x, y + 1));
      samples += 2;
    }
  }
  return energy / samples;
}

function strongestRepeatPeak(image, control) {
  const differences = new Float64Array(image.width * image.height);
  let mean = 0;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const value = luminance(image, x, y) - luminance(control, x, y);
      differences[y * image.width + x] = value;
      mean += value;
    }
  }
  mean /= differences.length;
  let variance = 0;
  for (const value of differences) variance += (value - mean) ** 2;
  if (variance === 0) return 0;
  let strongest = 0;
  for (const lag of [8, 16, 32, 64, 96, 128]) {
    let correlation = 0;
    let samples = 0;
    for (let y = 0; y < image.height; y += 2) {
      for (let x = 0; x < image.width - lag; x += 2) {
        correlation +=
          (differences[y * image.width + x] - mean) *
          (differences[y * image.width + x + lag] - mean);
        samples += 1;
      }
    }
    strongest = Math.max(strongest, Math.abs(correlation / samples) / (variance / differences.length));
  }
  return strongest;
}

function atmosphereBluePixels(image) {
  const center = image.width / 2;
  let count = 0;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const radius = Math.hypot(x + 0.5 - center, y + 0.5 - center);
      if (radius < 160 || radius > 185) continue;
      const offset = (y * image.width + x) * image.channels;
      const red = image.data[offset] ?? 0;
      const green = image.data[offset + 1] ?? 0;
      const blue = image.data[offset + 2] ?? 0;
      if (blue > red * 1.15 && blue > green * 1.05 && blue > 8) count += 1;
    }
  }
  return count;
}

const server = await createServer({
  root: process.cwd(),
  base: '/solar-voyager/',
  logLevel: 'error',
  server: { host: HOST, port: PORT, strictPort: true },
});
let browser;

try {
  await server.listen();
  browser = await chromium.launch({ headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: VIEWPORT_SIZE, height: VIEWPORT_SIZE } });
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  await page.goto(FIXTURE_URL, { waitUntil: 'networkidle', timeout: 60_000 });
  await page.waitForFunction(() => globalThis.__surfaceDetailHarness !== undefined, undefined, {
    timeout: 60_000,
  });

  const programs = await page.evaluate(() => globalThis.__surfaceDetailHarness.programSnapshot());
  assert.equal(programs.glError, 0);
  assert.equal(programs.afterFirstFrame, programs.afterWarmUp);

  const leoControlSnapshot = await page.evaluate(() => globalThis.__surfaceDetailHarness.renderLeo(false));
  const leoControlBuffer = await page.locator('canvas').screenshot();
  const leoDetailSnapshot = await page.evaluate(() => globalThis.__surfaceDetailHarness.renderLeo(true));
  const leoDetailBuffer = await page.locator('canvas').screenshot();
  const leoControl = await pixels(leoControlBuffer);
  const leoDetail = await pixels(leoDetailBuffer);
  const controlEnergy = highFrequencyEnergy(leoControl);
  const detailEnergy = highFrequencyEnergy(leoDetail);
  const repeatPeak = strongestRepeatPeak(leoDetail, leoControl);

  const farControlSnapshot = await page.evaluate(() => globalThis.__surfaceDetailHarness.renderFar(false));
  const farControlBuffer = await page.locator('canvas').screenshot();
  const farDetailSnapshot = await page.evaluate(() => globalThis.__surfaceDetailHarness.renderFar(true));
  const farDetailBuffer = await page.locator('canvas').screenshot();
  assert.ok(farDetailBuffer.equals(farControlBuffer), 'far detail changed production pixels');

  const atmosphereSnapshot = await page.evaluate(() => globalThis.__surfaceDetailHarness.renderAtmosphere());
  const atmosphereBuffer = await page.locator('canvas').screenshot();
  const atmosphere = await pixels(atmosphereBuffer);
  const offDiscBluePixels = atmosphereBluePixels(atmosphere);
  const cloudBefore = await page.evaluate(() => globalThis.__surfaceDetailHarness.advanceClouds(2_000));
  const cloudAfter = await page.evaluate(() => globalThis.__surfaceDetailHarness.advanceClouds(22_000));

  const metrics = { programs, controlEnergy, detailEnergy, repeatPeak, offDiscBluePixels };
  process.stdout.write(`${JSON.stringify(metrics, null, 2)}\n`);
  if (process.env.SURFACE_DETAIL_SCREENSHOTS !== undefined) {
    const outputDirectory = resolve(process.env.SURFACE_DETAIL_SCREENSHOTS);
    await mkdir(outputDirectory, { recursive: true });
    await Promise.all([
      writeFile(resolve(outputDirectory, 'leo-control.png'), leoControlBuffer),
      writeFile(resolve(outputDirectory, 'leo-detail.png'), leoDetailBuffer),
      writeFile(resolve(outputDirectory, 'far-control.png'), farControlBuffer),
      writeFile(resolve(outputDirectory, 'far-detail.png'), farDetailBuffer),
      writeFile(resolve(outputDirectory, 'atmosphere.png'), atmosphereBuffer),
    ]);
  }

  assert.equal(leoControlSnapshot.earthLoadState, 'ready');
  assert.equal(leoDetailSnapshot.earthTier, 3);
  assert.equal(leoDetailSnapshot.modelOpacity, 1);
  assert.equal(leoDetailSnapshot.detailBlend, 1);
  assert.equal(farControlSnapshot.detailBlend, 0);
  assert.equal(farDetailSnapshot.detailBlend, 0);
  assert.equal(atmosphereSnapshot.glError, 0);
  assert.ok(detailEnergy > controlEnergy * 1.08, `LEO detail lacks high-frequency gain: ${JSON.stringify({ controlEnergy, detailEnergy })}`);
  assert.ok(repeatPeak < 0.35, `LEO detail has a strong repeat peak: ${repeatPeak}`);
  assert.ok(offDiscBluePixels > 40, `Earth atmosphere rim is missing: ${offDiscBluePixels}`);
  assert.notDeepEqual(cloudAfter, cloudBefore, 'Earth cloud shell did not rotate');
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(consoleErrors, []);

} finally {
  if (browser !== undefined) await browser.close();
  await server.close();
}
