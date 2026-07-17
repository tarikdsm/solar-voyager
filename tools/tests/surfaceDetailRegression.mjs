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

function isInsideAnalysisDisc(image, x, y) {
  const centerX = image.width / 2;
  const centerY = image.height / 2;
  const radius = Math.min(image.width, image.height) * 0.46;
  return Math.hypot(x + 0.5 - centerX, y + 0.5 - centerY) <= radius;
}

function isInsideQuadrant(image, x, y, quadrant) {
  if (!isInsideAnalysisDisc(image, x, y)) return false;
  const right = x >= image.width / 2;
  const bottom = y >= image.height / 2;
  return quadrant === (bottom ? 2 : 0) + (right ? 1 : 0);
}

function includesAnalysisPoint(image, x, y, quadrant) {
  return quadrant === null
    ? isInsideAnalysisDisc(image, x, y)
    : isInsideQuadrant(image, x, y, quadrant);
}

function highFrequencyEnergy(image, quadrant = null) {
  let energy = 0;
  let samples = 0;
  for (let y = 1; y < image.height - 1; y += 1) {
    for (let x = 1; x < image.width - 1; x += 1) {
      if (!includesAnalysisPoint(image, x, y, quadrant)) continue;
      const value = luminance(image, x, y);
      if (includesAnalysisPoint(image, x + 1, y, quadrant)) {
        energy += Math.abs(value - luminance(image, x + 1, y));
        samples += 1;
      }
      if (includesAnalysisPoint(image, x, y + 1, quadrant)) {
        energy += Math.abs(value - luminance(image, x, y + 1));
        samples += 1;
      }
    }
  }
  return energy / samples;
}

function detailDifferenceField(image, control) {
  const differences = new Float64Array(image.width * image.height);
  let mean = 0;
  let samples = 0;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (!isInsideAnalysisDisc(image, x, y)) continue;
      const value = luminance(image, x, y) - luminance(control, x, y);
      differences[y * image.width + x] = value;
      mean += value;
      samples += 1;
    }
  }
  return { differences, mean: mean / samples };
}

function repeatPeakForRegion(image, field, axis, quadrant = null) {
  let variance = 0;
  let varianceSamples = 0;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (!includesAnalysisPoint(image, x, y, quadrant)) continue;
      variance += (field.differences[y * image.width + x] - field.mean) ** 2;
      varianceSamples += 1;
    }
  }
  if (variance === 0 || varianceSamples === 0) return { peak: 0, lag: 0 };
  const correlations = [];
  const maximumLag = quadrant === null ? 128 : 64;
  const lags = [];
  for (let lag = 4; lag <= maximumLag; lag += 4) lags.push(lag);
  for (const lag of lags) {
    let correlation = 0;
    let samples = 0;
    for (let y = 0; y < image.height; y += 2) {
      for (let x = 0; x < image.width; x += 2) {
        const otherX = axis === 'horizontal' ? x + lag : x;
        const otherY = axis === 'vertical' ? y + lag : y;
        if (otherX >= image.width || otherY >= image.height) continue;
        if (
          !includesAnalysisPoint(image, x, y, quadrant) ||
          !includesAnalysisPoint(image, otherX, otherY, quadrant)
        ) {
          continue;
        }
        correlation +=
          (field.differences[y * image.width + x] - field.mean) *
          (field.differences[otherY * image.width + otherX] - field.mean);
        samples += 1;
      }
    }
    if (samples > 0) {
      const normalized = Math.abs(correlation / samples) / (variance / varianceSamples);
      correlations.push(normalized);
    }
  }
  let strongestProminence = 0;
  let strongestCorrelation = 0;
  let strongestLag = 0;
  for (let index = 1; index < correlations.length - 1; index += 1) {
    const correlation = correlations[index] ?? 0;
    const neighborMean = ((correlations[index - 1] ?? 0) + (correlations[index + 1] ?? 0)) / 2;
    const prominence = correlation - neighborMean;
    if (prominence > strongestProminence) {
      strongestProminence = prominence;
      strongestCorrelation = correlation;
      strongestLag = lags[index] ?? 0;
    }
  }
  return {
    peak: strongestProminence,
    correlation: strongestCorrelation,
    lag: strongestLag,
  };
}

function spatialDetailMetrics(image, control) {
  const field = detailDifferenceField(image, control);
  const horizontalRepeat = repeatPeakForRegion(image, field, 'horizontal');
  const verticalRepeat = repeatPeakForRegion(image, field, 'vertical');
  const quadrantRepeatPeaks = [];
  const quadrantEnergyGains = [];
  for (let quadrant = 0; quadrant < 4; quadrant += 1) {
    const horizontal = repeatPeakForRegion(image, field, 'horizontal', quadrant);
    const vertical = repeatPeakForRegion(image, field, 'vertical', quadrant);
    quadrantRepeatPeaks.push(horizontal.peak >= vertical.peak ? horizontal : vertical);
    quadrantEnergyGains.push(
      highFrequencyEnergy(image, quadrant) / highFrequencyEnergy(control, quadrant),
    );
  }
  return {
    meanLuminanceDelta: field.mean,
    horizontalRepeat,
    verticalRepeat,
    quadrantRepeatPeaks,
    quadrantEnergyGains,
  };
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
  const spatialMetrics = spatialDetailMetrics(leoDetail, leoControl);

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

  const metrics = { programs, controlEnergy, detailEnergy, ...spatialMetrics, offDiscBluePixels };
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
  assert.ok(detailEnergy > controlEnergy * 1.04, `LEO detail lacks high-frequency gain: ${JSON.stringify({ controlEnergy, detailEnergy })}`);
  assert.ok(Math.abs(spatialMetrics.meanLuminanceDelta) < 2, `LEO detail changes mean luminance: ${spatialMetrics.meanLuminanceDelta}`);
  assert.ok(spatialMetrics.horizontalRepeat.peak < 0.15, `LEO detail has a horizontal repeat peak: ${JSON.stringify(spatialMetrics.horizontalRepeat)}`);
  assert.ok(spatialMetrics.verticalRepeat.peak < 0.15, `LEO detail has a vertical repeat peak: ${JSON.stringify(spatialMetrics.verticalRepeat)}`);
  assert.ok(Math.max(...spatialMetrics.quadrantRepeatPeaks.map((result) => result.peak)) < 0.18, `LEO detail repeats within a quadrant: ${JSON.stringify(spatialMetrics.quadrantRepeatPeaks)}`);
  assert.ok(Math.min(...spatialMetrics.quadrantEnergyGains) > 1.01, `LEO detail is not present in every quadrant: ${JSON.stringify(spatialMetrics.quadrantEnergyGains)}`);
  assert.ok(offDiscBluePixels > 40, `Earth atmosphere rim is missing: ${offDiscBluePixels}`);
  assert.notDeepEqual(cloudAfter, cloudBefore, 'Earth cloud shell did not rotate');
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(consoleErrors, []);

} finally {
  if (browser !== undefined) await browser.close();
  await server.close();
}
