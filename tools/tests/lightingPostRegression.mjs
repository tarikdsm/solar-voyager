import assert from 'node:assert/strict';

import { chromium } from 'playwright';
import sharp from 'sharp';
import { createServer } from 'vite';

const HOST = '127.0.0.1';
const PORT = 4178;
const VIEWPORT_SIZE = 512;
const FIXTURE_URL = `http://${HOST}:${PORT}/solar-voyager/tests/render/lightingPost.html`;

async function readPixels(buffer) {
  const { data, info } = await sharp(buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

function luminance(data, offset) {
  return (
    (data[offset] ?? 0) * 0.2126 +
    (data[offset + 1] ?? 0) * 0.7152 +
    (data[offset + 2] ?? 0) * 0.0722
  );
}

function earthMetrics(image) {
  let darkPixels = 0;
  let brightPixels = 0;
  let maxLuminance = 0;
  const count = image.width * image.height;
  for (let offset = 0; offset < image.data.length; offset += image.channels) {
    const value = luminance(image.data, offset);
    if (value < 32) darkPixels += 1;
    if (value > 96) brightPixels += 1;
    maxLuminance = Math.max(maxLuminance, value);
  }
  return {
    darkFraction: darkPixels / count,
    brightFraction: brightPixels / count,
    maxLuminance,
  };
}

function bloomMetrics(offImage, onImage) {
  let haloIncrease = 0;
  let cornerIncrease = 0;
  let cornerLuminance = 0;
  let cornerPixels = 0;
  const quadrantIncrease = [0, 0, 0, 0];
  const centreX = offImage.width / 2;
  const centreY = offImage.height / 2;
  for (let y = 0; y < offImage.height; y += 1) {
    for (let x = 0; x < offImage.width; x += 1) {
      const offset = (y * offImage.width + x) * offImage.channels;
      const increase = Math.max(0, luminance(onImage.data, offset) - luminance(offImage.data, offset));
      const dx = x + 0.5 - centreX;
      const dy = y + 0.5 - centreY;
      const radius = Math.sqrt(dx * dx + dy * dy);
      if (radius >= 60 && radius <= 150) {
        haloIncrease += increase;
        const quadrant = (y >= centreY ? 2 : 0) + (x >= centreX ? 1 : 0);
        quadrantIncrease[quadrant] += increase;
      }
      if (radius >= 300) cornerIncrease += increase;
      if ((x < 32 || x >= onImage.width - 32) && (y < 32 || y >= onImage.height - 32)) {
        cornerLuminance += luminance(onImage.data, offset);
        cornerPixels += 1;
      }
    }
  }
  return {
    haloIncrease,
    cornerIncrease,
    cornerMeanLuminance: cornerLuminance / cornerPixels,
    quadrantIncrease,
  };
}

function assertPipeline(snapshot, label) {
  assert.equal(snapshot.glError, 0, `${label}: WebGL error ${snapshot.glError}`);
  assert.equal(snapshot.bufferType, snapshot.expectedBufferType, `${label}: composer is not half-float`);
  assert.equal(snapshot.brightWidth, VIEWPORT_SIZE / 2, `${label}: bloom width is not half-resolution`);
  assert.equal(snapshot.brightHeight, VIEWPORT_SIZE / 2, `${label}: bloom height is not half-resolution`);
  assert.deepEqual(snapshot.passNames, ['RenderPass', 'UnrealBloomPass', 'OutputPass']);
  assert.equal(snapshot.toneMapping, snapshot.expectedToneMapping, `${label}: ACES is not active`);
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
  browser = await chromium.launch({
    headless: true,
    args: ['--enable-webgl', '--ignore-gpu-blocklist'],
  });
  const page = await browser.newPage({ viewport: { width: VIEWPORT_SIZE, height: VIEWPORT_SIZE } });
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  await page.goto(FIXTURE_URL, { waitUntil: 'networkidle', timeout: 60_000 });
  await page.waitForFunction(() => globalThis.__lightingPostHarness !== undefined);
  await page.waitForFunction(
    () => globalThis.__lightingPostHarness.renderEarthNight().earthLoadState === 'ready',
    undefined,
    { timeout: 60_000 },
  );
  const earthSnapshot = await page.evaluate(() => globalThis.__lightingPostHarness.renderEarthNight());
  assertPipeline(earthSnapshot, 'earth night');
  const earthImage = await readPixels(await page.locator('canvas').screenshot());
  const earth = earthMetrics(earthImage);

  const bloomOffSnapshot = await page.evaluate(() => globalThis.__lightingPostHarness.renderBloom(false));
  assertPipeline(bloomOffSnapshot, 'bloom off');
  const bloomOffImage = await readPixels(await page.locator('canvas').screenshot());
  const bloomOnSnapshot = await page.evaluate(() => globalThis.__lightingPostHarness.renderBloom(true));
  assertPipeline(bloomOnSnapshot, 'bloom on');
  const bloomOnImage = await readPixels(await page.locator('canvas').screenshot());
  const bloom = bloomMetrics(bloomOffImage, bloomOnImage);

  assert.ok(earth.darkFraction > 0.5, `Earth night side is not mostly dark: ${JSON.stringify({ earth, earthSnapshot })}`);
  assert.ok(earth.brightFraction > 0.0001, `Earth night lights are not visible: ${JSON.stringify({ earth, earthSnapshot })}`);
  assert.ok(earth.brightFraction < 0.15, `Earth night lights are not localized: ${JSON.stringify(earth)}`);
  assert.ok(bloom.haloIncrease > 50_000, `Bloom added no exterior halo: ${JSON.stringify(bloom)}`);
  assert.ok(
    Math.max(...bloom.quadrantIncrease) / Math.min(...bloom.quadrantIncrease) < 1.2,
    `Bloom halo is asymmetric: ${JSON.stringify(bloom)}`,
  );
  assert.ok(bloom.cornerIncrease < bloom.haloIncrease * 0.1, `Bloom leaked across the frame: ${JSON.stringify(bloom)}`);
  assert.ok(bloom.cornerMeanLuminance < 16, `Bloom corners are not dark: ${JSON.stringify(bloom)}`);
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(consoleErrors, []);
  process.stdout.write(`${JSON.stringify({ earth, bloom }, null, 2)}\n`);
} finally {
  if (browser !== undefined) await browser.close();
  await server.close();
}
