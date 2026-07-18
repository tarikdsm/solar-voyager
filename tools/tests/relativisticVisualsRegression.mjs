import assert from 'node:assert/strict';

import { chromium } from 'playwright';
import sharp from 'sharp';
import { createServer } from 'vite';

const HOST = '127.0.0.1';
const PORT = 4191;
const WIDTH = 512;
const HEIGHT = 256;
const FIXTURE_URL = `http://${HOST}:${String(PORT)}/solar-voyager/tests/render/relativisticVisuals.html`;

async function readPixels(buffer) {
  const { data, info } = await sharp(buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { channels: info.channels, data, height: info.height, width: info.width };
}

function luminance(red, green, blue) {
  return red * 0.2126 + green * 0.7152 + blue * 0.0722;
}

function brightestCenterColor(image) {
  let bestLuminance = -1;
  let best = { blue: 0, green: 0, red: 0 };
  const centerX = image.width / 2;
  const centerY = image.height / 2;
  for (let y = centerY - 8; y < centerY + 8; y += 1) {
    for (let x = centerX - 8; x < centerX + 8; x += 1) {
      const offset = (y * image.width + x) * image.channels;
      const red = image.data[offset] ?? 0;
      const green = image.data[offset + 1] ?? 0;
      const blue = image.data[offset + 2] ?? 0;
      const value = luminance(red, green, blue);
      if (value > bestLuminance) {
        bestLuminance = value;
        best = { blue, green, red };
      }
    }
  }
  return { ...best, luminance: bestLuminance, blueRedRatio: best.blue / Math.max(1, best.red) };
}

function greenMarkerX(image) {
  let totalWeight = 0;
  let weightedX = 0;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const offset = (y * image.width + x) * image.channels;
      const red = image.data[offset] ?? 0;
      const green = image.data[offset + 1] ?? 0;
      const blue = image.data[offset + 2] ?? 0;
      if (green < 16 || green <= red * 1.4 || green <= blue * 1.2) continue;
      const weight = green - Math.max(red, blue);
      totalWeight += weight;
      weightedX += (x + 0.5) * weight;
    }
  }
  assert.ok(totalWeight > 0, 'green angular marker was not visible');
  return weightedX / totalWeight;
}

function expectedMarkerX(beta, fieldOfViewDeg, width, height) {
  const gamma = 1 / Math.sqrt(1 - beta * beta);
  const directionX = 0.5;
  const directionZ = -Math.sqrt(3) / 2;
  if (beta === 0) {
    const tangentHalfFov = Math.tan((fieldOfViewDeg * Math.PI) / 360);
    const ndcX = directionX / (-directionZ * tangentHalfFov * (width / height));
    return ((ndcX + 1) * width) / 2;
  }
  const betaZ = -beta;
  const dot = betaZ * directionZ;
  const coefficient = ((gamma - 1) / (beta * beta)) * dot + gamma;
  const denominator = gamma * (1 + dot);
  const observedX = directionX / denominator;
  const observedZ = (directionZ + coefficient * betaZ) / denominator;
  const tangentHalfFov = Math.tan((fieldOfViewDeg * Math.PI) / 360);
  const ndcX = observedX / (-observedZ * tangentHalfFov * (width / height));
  return ((ndcX + 1) * width) / 2;
}

function normalizedImageDelta(left, right) {
  assert.equal(left.data.length, right.data.length);
  let total = 0;
  for (let index = 0; index < left.data.length; index += 1) {
    total += Math.abs((left.data[index] ?? 0) - (right.data[index] ?? 0));
  }
  return total / (left.data.length * 255);
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
    channel: 'chrome',
    headless: true,
    args: ['--enable-webgl', '--ignore-gpu-blocklist'],
  });
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
  const browserErrors = [];
  page.on('pageerror', (error) => browserErrors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(`console: ${message.text()}`);
  });
  await page.goto(FIXTURE_URL, { waitUntil: 'networkidle', timeout: 60_000 });
  await page.waitForFunction(() => globalThis.__relativisticVisualsHarness !== undefined);

  async function renderAndCapture(method, value, facing) {
    const snapshot = await page.evaluate(
      ({ facing: selectedFacing, method: selectedMethod, value: selectedValue }) =>
        selectedMethod === 'beta'
          ? globalThis.__relativisticVisualsHarness.renderBeta(selectedValue, selectedFacing)
          : globalThis.__relativisticVisualsHarness.renderGamma(selectedValue),
      { facing, method, value },
    );
    const image = await readPixels(await page.locator('canvas').screenshot());
    return { image, snapshot };
  }

  const baselineForward = await renderAndCapture('beta', 0, 'forward');
  const activeForward = await renderAndCapture('beta', 0.9, 'forward');
  const baselineAft = await renderAndCapture('beta', 0, 'aft');
  const activeAft = await renderAndCapture('beta', 0.9, 'aft');
  const thresholdLow = await renderAndCapture('gamma', 1.049, 'forward');
  const thresholdHigh = await renderAndCapture('gamma', 1.051, 'forward');

  const harness = await page.evaluate(() => ({
    fieldOfViewDeg: globalThis.__relativisticVisualsHarness.fieldOfViewDeg,
    height: globalThis.__relativisticVisualsHarness.height,
    width: globalThis.__relativisticVisualsHarness.width,
  }));
  const baselineMarkerX = greenMarkerX(baselineForward.image);
  const activeMarkerX = greenMarkerX(activeForward.image);
  const expectedBaselineX = expectedMarkerX(0, harness.fieldOfViewDeg, harness.width, harness.height);
  const expectedActiveX = expectedMarkerX(0.9, harness.fieldOfViewDeg, harness.width, harness.height);
  const baselineForwardColor = brightestCenterColor(baselineForward.image);
  const activeForwardColor = brightestCenterColor(activeForward.image);
  const baselineAftColor = brightestCenterColor(baselineAft.image);
  const activeAftColor = brightestCenterColor(activeAft.image);
  const thresholdDelta = normalizedImageDelta(thresholdLow.image, thresholdHigh.image);

  assert.ok(Math.abs(baselineMarkerX - expectedBaselineX) <= 0.5, `baseline marker projection: ${baselineMarkerX} vs ${expectedBaselineX}`);
  assert.ok(Math.abs(activeMarkerX - expectedActiveX) <= 0.5, `active marker projection: ${activeMarkerX} vs ${expectedActiveX}`);
  assert.ok(activeMarkerX < baselineMarkerX - 40, `forward sky did not visibly compress: ${baselineMarkerX} -> ${activeMarkerX}`);
  assert.ok(activeForwardColor.blueRedRatio > baselineForwardColor.blueRedRatio + 0.05, `forward source did not blueshift: ${JSON.stringify({ activeForwardColor, baselineForwardColor })}`);
  assert.ok(activeAftColor.blueRedRatio < baselineAftColor.blueRedRatio - 0.05, `aft source did not redshift: ${JSON.stringify({ activeAftColor, baselineAftColor })}`);
  assert.ok(activeForwardColor.luminance > activeAftColor.luminance, `headlight beaming did not brighten forward view: ${JSON.stringify({ activeAftColor, activeForwardColor })}`);
  assert.ok(thresholdDelta < 0.01, `activation threshold discontinuity: ${thresholdDelta}`);
  assert.equal(baselineForward.snapshot.passEnabled, false);
  assert.equal(activeForward.snapshot.passEnabled, true);
  assert.equal(activeForward.snapshot.drawCalls - baselineForward.snapshot.drawCalls, 1);
  for (const result of [baselineForward, activeForward, baselineAft, activeAft, thresholdLow, thresholdHigh]) {
    assert.equal(result.snapshot.glError, 0);
  }
  assert.deepEqual(browserErrors, []);

  process.stdout.write(
    `${JSON.stringify(
      {
        activeAftColor,
        activeForwardColor,
        activeMarkerX,
        baselineAftColor,
        baselineForwardColor,
        baselineMarkerX,
        drawCalls: {
          active: activeForward.snapshot.drawCalls,
          baseline: baselineForward.snapshot.drawCalls,
        },
        expectedActiveX,
        expectedBaselineX,
        thresholdDelta,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  if (browser !== undefined) await browser.close();
  await server.close();
}
