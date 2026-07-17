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

function earthMetrics(emissionImage, controlImage) {
  let darkPixels = 0;
  let emittingPixels = 0;
  let maxEmissionIncrease = 0;
  let discPixels = 0;
  const centreX = emissionImage.width / 2;
  const centreY = emissionImage.height / 2;
  for (let y = 0; y < emissionImage.height; y += 1) {
    for (let x = 0; x < emissionImage.width; x += 1) {
      const dx = x + 0.5 - centreX;
      const dy = y + 0.5 - centreY;
      if (dx * dx + dy * dy > 120 * 120) continue;
      const offset = (y * emissionImage.width + x) * emissionImage.channels;
      const value = luminance(emissionImage.data, offset);
      const increase = value - luminance(controlImage.data, offset);
      discPixels += 1;
      if (value < 32) darkPixels += 1;
      if (increase > 32) emittingPixels += 1;
      maxEmissionIncrease = Math.max(maxEmissionIncrease, increase);
    }
  }
  return {
    darkFraction: darkPixels / discPixels,
    emittingFraction: emittingPixels / discPixels,
    maxEmissionIncrease,
  };
}

function glareMetrics(image, controlImage) {
  const quadrantLuminance = [0, 0, 0, 0];
  let cornerLuminance = 0;
  let cornerPixels = 0;
  let weightedX = 0;
  let weightedY = 0;
  let totalIncrease = 0;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const offset = (y * image.width + x) * image.channels;
      const increase = Math.max(
        0,
        luminance(image.data, offset) - luminance(controlImage.data, offset),
      );
      totalIncrease += increase;
      weightedX += (x + 0.5) * increase;
      weightedY += (y + 0.5) * increase;
    }
  }
  const centreX = weightedX / totalIncrease;
  const centreY = weightedY / totalIncrease;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const offset = (y * image.width + x) * image.channels;
      const value = Math.max(
        0,
        luminance(image.data, offset) - luminance(controlImage.data, offset),
      );
      const dx = x + 0.5 - centreX;
      const dy = y + 0.5 - centreY;
      const radius = Math.sqrt(dx * dx + dy * dy);
      if (radius >= 35 && radius <= 80) {
        const quadrant = (y >= centreY ? 2 : 0) + (x >= centreX ? 1 : 0);
        quadrantLuminance[quadrant] += value;
      }
      if ((x < 32 || x >= image.width - 32) && (y < 32 || y >= image.height - 32)) {
        cornerLuminance += value;
        cornerPixels += 1;
      }
    }
  }
  const centerOffset =
    (Math.round(centreY) * image.width + Math.round(centreX)) * image.channels;
  return {
    centreX,
    centreY,
    centerLuminance: luminance(image.data, centerOffset),
    cornerMeanLuminance: cornerLuminance / cornerPixels,
    quadrantLuminance,
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
  assert.ok(
    Math.abs(snapshot.brightWidth * 2 - snapshot.bufferWidth) <= 1,
    `${label}: bloom width is not half the effective render width`,
  );
  assert.ok(
    Math.abs(snapshot.brightHeight * 2 - snapshot.bufferHeight) <= 1,
    `${label}: bloom height is not half the effective render height`,
  );
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
  const directFallback = await page.evaluate(() =>
    globalThis.__lightingPostHarness.directFallbackPrograms(),
  );
  assert.equal(directFallback.glError, 0, `direct fallback: WebGL error ${directFallback.glError}`);
  assert.equal(
    directFallback.afterFirstFrame,
    directFallback.afterWarmUp,
    `direct fallback compiled programs on the first gameplay frame: ${JSON.stringify(directFallback)}`,
  );
  await page.waitForFunction(
    () => globalThis.__lightingPostHarness.renderEarthNight(true).earthLoadState === 'ready',
    undefined,
    { timeout: 60_000 },
  );
  const earthSnapshot = await page.evaluate(() =>
    globalThis.__lightingPostHarness.renderEarthNight(true),
  );
  assertPipeline(earthSnapshot, 'earth night');
  const earthEmissionImage = await readPixels(await page.locator('canvas').screenshot());
  await page.evaluate(() => globalThis.__lightingPostHarness.renderEarthNight(false));
  const earthControlImage = await readPixels(await page.locator('canvas').screenshot());
  const earth = earthMetrics(earthEmissionImage, earthControlImage);

  const sunOffSnapshot = await page.evaluate(() =>
    globalThis.__lightingPostHarness.renderProductionSun(false, true),
  );
  assertPipeline(sunOffSnapshot, 'production Sun bloom off');
  assert.equal(sunOffSnapshot.sunTier, 2, 'production Sun fixture did not select tier 2');
  assert.equal(sunOffSnapshot.sphereOpacity, 1, 'production Sun sphere is not opaque');
  const sunOffImage = await readPixels(await page.locator('canvas').screenshot());
  await page.evaluate(() => globalThis.__lightingPostHarness.renderProductionSun(false, false));
  const sunNoGlareImage = await readPixels(await page.locator('canvas').screenshot());
  const sunOnSnapshot = await page.evaluate(() =>
    globalThis.__lightingPostHarness.renderProductionSun(true, true),
  );
  assertPipeline(sunOnSnapshot, 'production Sun bloom on');
  const sunOnImage = await readPixels(await page.locator('canvas').screenshot());
  const glare = glareMetrics(sunOffImage, sunNoGlareImage);
  const bloom = bloomMetrics(sunOffImage, sunOnImage);

  assert.ok(earth.darkFraction > 0.75, `Earth disc is not mostly dark: ${JSON.stringify({ earth, earthSnapshot })}`);
  assert.ok(earth.emittingFraction > 0.0001, `Earth emission has no visible effect inside the disc: ${JSON.stringify({ earth, earthSnapshot })}`);
  assert.ok(earth.emittingFraction < 0.2, `Earth night lights are not localized: ${JSON.stringify(earth)}`);
  assert.ok(earth.maxEmissionIncrease > 5, `Earth night lights lack visible contrast: ${JSON.stringify(earth)}`);
  assert.ok(bloom.haloIncrease > 50_000, `Bloom added no exterior halo: ${JSON.stringify(bloom)}`);
  assert.ok(
    Math.max(...bloom.quadrantIncrease) / Math.min(...bloom.quadrantIncrease) < 1.2,
    `Bloom halo is asymmetric: ${JSON.stringify(bloom)}`,
  );
  assert.ok(bloom.cornerIncrease < bloom.haloIncrease * 0.1, `Bloom leaked across the frame: ${JSON.stringify(bloom)}`);
  assert.ok(bloom.cornerMeanLuminance < 16, `Bloom corners are not dark: ${JSON.stringify(bloom)}`);
  assert.ok(glare.centerLuminance > 32, `Production Sun disc is not visible: ${JSON.stringify(glare)}`);
  assert.ok(glare.cornerMeanLuminance < 8, `Production glare fills the frame: ${JSON.stringify(glare)}`);
  assert.ok(
    Math.max(...glare.quadrantLuminance) / Math.min(...glare.quadrantLuminance) < 1.15,
    `Production glare is not radially symmetric: ${JSON.stringify(glare)}`,
  );
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(consoleErrors, []);
  process.stdout.write(`${JSON.stringify({ directFallback, earth, glare, bloom }, null, 2)}\n`);
} finally {
  if (browser !== undefined) await browser.close();
  await server.close();
}
