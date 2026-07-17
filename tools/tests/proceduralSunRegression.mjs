import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { chromium } from 'playwright';
import sharp from 'sharp';
import { createServer } from 'vite';

const HOST = '127.0.0.1';
const PORT = 4180;
const VIEWPORT_SIZE = 512;
const FIXTURE_URL = `http://${HOST}:${PORT}/solar-voyager/tests/render/proceduralSun.html`;
const ANALYSIS_RADIUS_PX = 110;
const PROJECTED_DISC_RADIUS_PX =
  ((VIEWPORT_SIZE / 2) * Math.tan(Math.asin(1 / 3))) / Math.tan((75 * Math.PI) / 360);

function outputDirectory() {
  const flagIndex = process.argv.indexOf('--output-dir');
  if (flagIndex < 0) return null;
  const value = process.argv[flagIndex + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error('--output-dir requires a path.');
  }
  return resolve(value);
}

async function pixels(buffer) {
  const { data, info } = await sharp(buffer)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
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

function radiusFromCenter(image, x, y) {
  return Math.hypot(x + 0.5 - image.width / 2, y + 0.5 - image.height / 2);
}

function annulusMean(image, innerRadius, outerRadius) {
  let total = 0;
  let samples = 0;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const radius = radiusFromCenter(image, x, y);
      if (radius < innerRadius || radius >= outerRadius) continue;
      total += luminance(image, x, y);
      samples += 1;
    }
  }
  return total / samples;
}

function edgeEnergy(image, quadrant = null) {
  let energy = 0;
  let samples = 0;
  for (let y = 1; y < image.height - 1; y += 1) {
    for (let x = 1; x < image.width - 1; x += 1) {
      if (radiusFromCenter(image, x, y) > ANALYSIS_RADIUS_PX) continue;
      const actualQuadrant = (y >= image.height / 2 ? 2 : 0) + (x >= image.width / 2 ? 1 : 0);
      if (quadrant !== null && actualQuadrant !== quadrant) continue;
      const value = luminance(image, x, y);
      energy += Math.abs(value - luminance(image, x + 1, y));
      energy += Math.abs(value - luminance(image, x, y + 1));
      samples += 2;
    }
  }
  return energy / samples;
}

function animationMetrics(first, second) {
  const differences = new Float64Array(first.width * first.height);
  let changed = 0;
  let samples = 0;
  let firstMean = 0;
  let secondMean = 0;
  for (let y = 0; y < first.height; y += 1) {
    for (let x = 0; x < first.width; x += 1) {
      if (radiusFromCenter(first, x, y) > ANALYSIS_RADIUS_PX) continue;
      const firstValue = luminance(first, x, y);
      const secondValue = luminance(second, x, y);
      const difference = secondValue - firstValue;
      differences[y * first.width + x] = difference;
      if (Math.abs(difference) >= 2) changed += 1;
      firstMean += firstValue;
      secondMean += secondValue;
      samples += 1;
    }
  }
  return {
    differences,
    changedFraction: changed / samples,
    firstMean: firstMean / samples,
    meanDelta: secondMean / samples - firstMean / samples,
  };
}

function repeatPeak(image, differences, axis) {
  let variance = 0;
  let varianceSamples = 0;
  for (let y = 0; y < image.height; y += 2) {
    for (let x = 0; x < image.width; x += 2) {
      if (radiusFromCenter(image, x, y) > ANALYSIS_RADIUS_PX) continue;
      variance += (differences[y * image.width + x] ?? 0) ** 2;
      varianceSamples += 1;
    }
  }
  if (variance === 0) return { peak: 0, correlation: 0, lag: 0 };
  const correlations = [];
  const lags = [];
  for (let lag = 4; lag <= 64; lag += 4) {
    let correlation = 0;
    let samples = 0;
    for (let y = 0; y < image.height; y += 2) {
      for (let x = 0; x < image.width; x += 2) {
        const otherX = axis === 'horizontal' ? x + lag : x;
        const otherY = axis === 'vertical' ? y + lag : y;
        if (otherX >= image.width || otherY >= image.height) continue;
        if (
          radiusFromCenter(image, x, y) > ANALYSIS_RADIUS_PX ||
          radiusFromCenter(image, otherX, otherY) > ANALYSIS_RADIUS_PX
        ) {
          continue;
        }
        correlation +=
          (differences[y * image.width + x] ?? 0) *
          (differences[otherY * image.width + otherX] ?? 0);
        samples += 1;
      }
    }
    correlations.push(Math.abs(correlation / samples) / (variance / varianceSamples));
    lags.push(lag);
  }
  let result = { peak: 0, correlation: 0, lag: 0 };
  for (let index = 1; index < correlations.length - 1; index += 1) {
    const correlation = correlations[index] ?? 0;
    const neighborMean = ((correlations[index - 1] ?? 0) + (correlations[index + 1] ?? 0)) / 2;
    const peak = correlation - neighborMean;
    if (peak > result.peak) result = { peak, correlation, lag: lags[index] ?? 0 };
  }
  return result;
}

function warmOffDiscPixels(image) {
  let pixels = 0;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const radius = radiusFromCenter(image, x, y);
      if (radius < 125 || radius > 200) continue;
      const offset = (y * image.width + x) * image.channels;
      const red = image.data[offset] ?? 0;
      const green = image.data[offset + 1] ?? 0;
      const blue = image.data[offset + 2] ?? 0;
      if (red > 24 && red > green * 1.25 && green > blue * 1.1) pixels += 1;
    }
  }
  return pixels;
}

function solarRoiMetrics(image) {
  let litPixels = 0;
  let peakLuminance = 0;
  let backgroundTotal = 0;
  let backgroundSamples = 0;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const radius = radiusFromCenter(image, x, y);
      const value = luminance(image, x, y);
      if (radius < 16) {
        if (value >= 8) litPixels += 1;
        peakLuminance = Math.max(peakLuminance, value);
      } else if (radius >= 32 && radius < 64) {
        backgroundTotal += value;
        backgroundSamples += 1;
      }
    }
  }
  return {
    litPixels,
    peakLuminance,
    backgroundMeanLuminance: backgroundTotal / backgroundSamples,
  };
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
  const page = await browser.newPage({
    viewport: { width: VIEWPORT_SIZE, height: VIEWPORT_SIZE },
  });
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  await page.goto(FIXTURE_URL, { waitUntil: 'networkidle', timeout: 60_000 });
  await page.waitForFunction(() => globalThis.__proceduralSunHarness !== undefined, undefined, {
    timeout: 60_000,
  });

  const programs = await page.evaluate(() => globalThis.__proceduralSunHarness.programSnapshot());
  const closeSnapshot = await page.evaluate(() =>
    globalThis.__proceduralSunHarness.renderClose(0, 'full', true),
  );
  const closeBuffer = await page.locator('canvas').screenshot();
  await page.evaluate(() => globalThis.__proceduralSunHarness.renderCloseProfile(0));
  const profileBuffer = await page.locator('canvas').screenshot();
  await page.evaluate(() => globalThis.__proceduralSunHarness.renderClose(300, 'full', true));
  const animatedBuffer = await page.locator('canvas').screenshot();
  await page.evaluate(() => globalThis.__proceduralSunHarness.renderClose(0, 'full', false));
  const fallbackBuffer = await page.locator('canvas').screenshot();

  const distanceBuffers = {};
  for (const distance of ['mercury', 'earth', 'neptune']) {
    await page.evaluate((label) => globalThis.__proceduralSunHarness.renderDistance(label, 0), distance);
    distanceBuffers[distance] = await page.locator('canvas').screenshot();
  }

  const close = await pixels(closeBuffer);
  const profile = await pixels(profileBuffer);
  const animated = await pixels(animatedBuffer);
  const fallback = await pixels(fallbackBuffer);
  const mercury = await pixels(distanceBuffers.mercury);
  const earth = await pixels(distanceBuffers.earth);
  const neptune = await pixels(distanceBuffers.neptune);
  const centerMean = annulusMean(profile, 0, PROJECTED_DISC_RADIUS_PX * 0.2);
  const halfRadiusMean = annulusMean(
    profile,
    PROJECTED_DISC_RADIUS_PX * 0.45,
    PROJECTED_DISC_RADIUS_PX * 0.6,
  );
  const limbMean = annulusMean(
    profile,
    PROJECTED_DISC_RADIUS_PX * 0.92,
    PROJECTED_DISC_RADIUS_PX * 0.98,
  );
  const animation = animationMetrics(close, animated);
  const horizontalRepeat = repeatPeak(close, animation.differences, 'horizontal');
  const verticalRepeat = repeatPeak(close, animation.differences, 'vertical');
  const quadrantEdgeEnergy = [0, 1, 2, 3].map((quadrant) => edgeEnergy(close, quadrant));
  const fallbackAnimation = animationMetrics(close, fallback);
  const metrics = {
    programs,
    closeSnapshot,
    radial: {
      centerMean,
      halfRadiusMean,
      limbMean,
      halfRadiusCenterRatio: halfRadiusMean / centerMean,
      limbCenterRatio: limbMean / centerMean,
    },
    animation: {
      changedFraction: animation.changedFraction,
      firstMean: animation.firstMean,
      meanDelta: animation.meanDelta,
    },
    fallbackChangedFraction: fallbackAnimation.changedFraction,
    horizontalRepeat,
    verticalRepeat,
    quadrantEdgeEnergy,
    offDiscWarmPixels: warmOffDiscPixels(close),
    distanceSolarRoi: {
      mercury: solarRoiMetrics(mercury),
      earth: solarRoiMetrics(earth),
      neptune: solarRoiMetrics(neptune),
    },
  };
  process.stdout.write(`${JSON.stringify(metrics, null, 2)}\n`);

  const directory = outputDirectory();
  if (directory !== null) {
    await mkdir(directory, { recursive: true });
    await Promise.all([
      writeFile(resolve(directory, 'close-0.png'), closeBuffer),
      writeFile(resolve(directory, 'close-profile.png'), profileBuffer),
      writeFile(resolve(directory, 'close-animated.png'), animatedBuffer),
      writeFile(resolve(directory, 'close-fallback.png'), fallbackBuffer),
      writeFile(resolve(directory, 'mercury.png'), distanceBuffers.mercury),
      writeFile(resolve(directory, 'earth.png'), distanceBuffers.earth),
      writeFile(resolve(directory, 'neptune.png'), distanceBuffers.neptune),
    ]);
  }

  assert.equal(programs.glError, 0);
  assert.equal(programs.afterFirstFrame, programs.afterWarmUp);
  assert.equal(closeSnapshot.sunLoadState, 'ready');
  assert.equal(closeSnapshot.sunTier, 3);
  assert.equal(closeSnapshot.modelOpacity, 1);
  // These post-ACES bands validate the isolated disc; the shader unit test locks
  // the approved linear I(mu) coefficients before tone mapping.
  assert.ok(metrics.radial.limbCenterRatio >= 0.85 && metrics.radial.limbCenterRatio <= 0.95);
  assert.ok(
    metrics.radial.halfRadiusCenterRatio >= 0.94 &&
      metrics.radial.halfRadiusCenterRatio <= 1.02,
  );
  assert.ok(animation.changedFraction >= 0.03);
  assert.ok(Math.abs(animation.meanDelta) <= animation.firstMean * 0.02);
  assert.ok(fallbackAnimation.changedFraction >= 0.03);
  assert.ok(horizontalRepeat.peak < 0.18);
  assert.ok(verticalRepeat.peak < 0.18);
  assert.ok(Math.min(...quadrantEdgeEnergy) >= 0.2);
  assert.ok(metrics.offDiscWarmPixels >= 24);
  assert.ok(metrics.distanceSolarRoi.mercury.litPixels >= 64);
  assert.ok(metrics.distanceSolarRoi.earth.litPixels >= 8);
  assert.ok(metrics.distanceSolarRoi.neptune.litPixels >= 1);
  for (const distance of Object.values(metrics.distanceSolarRoi)) {
    assert.ok(distance.peakLuminance >= 32);
    assert.ok(distance.backgroundMeanLuminance < 2);
  }
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(consoleErrors, []);
} finally {
  if (browser !== undefined) await browser.close();
  await server.close();
}
