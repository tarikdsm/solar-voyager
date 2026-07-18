import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { chromium } from 'playwright';
import sharp from 'sharp';
import { createServer } from 'vite';

const HOST = '127.0.0.1';
const PORT = 4178;
const FIXTURE_URL = `http://${HOST}:${PORT}/solar-voyager/tests/render/cameraControls.html`;
const TRANSFER_FRAMES = 90;
const TRANSFER_ZOOM_FRAME = 45;
const DELTA_SEC = 1 / 60;

function cameraDistance(left, right) {
  return Math.hypot(
    right.cameraX - left.cameraX,
    right.cameraY - left.cameraY,
    right.cameraZ - left.cameraZ,
  );
}

async function screenshotEvidence(buffer) {
  const { data, info } = await sharp(buffer)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const centerOffset =
    (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * info.channels;
  return {
    centerRgb: [data[centerOffset], data[centerOffset + 1], data[centerOffset + 2]],
    sha256: createHash('sha256').update(buffer).digest('hex'),
  };
}

async function capturePageClip(page, clip) {
  const session = await page.context().newCDPSession(page);
  try {
    const screenshot = await session.send('Page.captureScreenshot', {
      captureBeyondViewport: false,
      clip: { ...clip, scale: 1 },
      format: 'png',
      fromSurface: true,
    });
    return Buffer.from(screenshot.data, 'base64');
  } finally {
    await session.detach();
  }
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
  const page = await browser.newPage({ viewport: { width: 256, height: 256 } });
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  await page.goto(FIXTURE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => globalThis.__cameraControlsHarness !== undefined);

  const surfaceFrames = [];
  surfaceFrames.push(await page.evaluate(() => globalThis.__cameraControlsHarness.zoomToEarthSurface()));
  for (let frame = 0; frame < 30; frame += 1) {
    surfaceFrames.push(
      await page.evaluate((deltaSec) => globalThis.__cameraControlsHarness.renderFrame(deltaSec), 1 / 60),
    );
  }
  const surfaceReference = surfaceFrames[0];
  assert.ok(surfaceReference.litPixels > 0, 'surface-skimming Earth rendered dark');
  for (const [index, snapshot] of surfaceFrames.entries()) {
    assert.equal(snapshot.glError, 0, `surface frame ${String(index)} WebGL error`);
    assert.equal(snapshot.cameraX, surfaceReference.cameraX, `surface frame ${String(index)} camera x jitter`);
    assert.equal(snapshot.cameraY, surfaceReference.cameraY, `surface frame ${String(index)} camera y jitter`);
    assert.equal(snapshot.cameraZ, surfaceReference.cameraZ, `surface frame ${String(index)} camera z jitter`);
    assert.equal(snapshot.earthRenderX, surfaceReference.earthRenderX, `surface frame ${String(index)} render x jitter`);
    assert.equal(snapshot.earthRenderY, surfaceReference.earthRenderY, `surface frame ${String(index)} render y jitter`);
    assert.equal(snapshot.earthRenderZ, surfaceReference.earthRenderZ, `surface frame ${String(index)} render z jitter`);
    assert.equal(snapshot.pixelChecksum, surfaceReference.pixelChecksum, `surface frame ${String(index)} pixel jitter`);
  }

  assert.equal(await page.evaluate(() => globalThis.__cameraControlsHarness.beginJupiterTransfer()), true);
  const transferFrames = [];
  transferFrames.push(await page.evaluate(() => globalThis.__cameraControlsHarness.renderFrame(0)));
  for (let frame = 0; frame < TRANSFER_FRAMES; frame += 1) {
    if (frame === TRANSFER_ZOOM_FRAME) {
      await page.evaluate(() => globalThis.__cameraControlsHarness.zoomByWheel(-1_000));
    }
    transferFrames.push(
      await page.evaluate(
        (deltaSec) => globalThis.__cameraControlsHarness.renderFrame(deltaSec),
        DELTA_SEC,
      ),
    );
  }

  const travelKm = Math.hypot(
    transferFrames.at(-1).focusX - transferFrames[0].focusX,
    transferFrames.at(-1).focusY - transferFrames[0].focusY,
    transferFrames.at(-1).focusZ - transferFrames[0].focusZ,
  );
  const stepDistancesKm = [];
  const smoothStepDistancesKm = [];
  for (let index = 1; index < transferFrames.length; index += 1) {
    const previous = transferFrames[index - 1];
    const current = transferFrames[index];
    assert.equal(current.glError, 0, `transfer frame ${String(index)} WebGL error`);
    assert.ok(Number.isFinite(current.cameraX));
    assert.ok(Number.isFinite(current.cameraY));
    assert.ok(Number.isFinite(current.cameraZ));
    const stepDistanceKm = cameraDistance(previous, current);
    stepDistancesKm.push(stepDistanceKm);
    if (index - 1 !== TRANSFER_ZOOM_FRAME) smoothStepDistancesKm.push(stepDistanceKm);
  }
  assert.ok(stepDistancesKm[0] < travelKm * 0.001, 'transfer jumps at Earth departure');
  assert.ok(stepDistancesKm.at(-1) < travelKm * 0.001, 'transfer jumps at Jupiter arrival');
  assert.ok(
    Math.max(...smoothStepDistancesKm) < travelKm * 0.04,
    'transfer contains a discontinuous camera step',
  );

  const finalFrame = transferFrames.at(-1);
  assert.equal(finalFrame.focusId, 'jupiter');
  assert.equal(finalFrame.transitioning, false);
  assert.ok(finalFrame.litPixels > 0, 'final Jupiter frame rendered dark');
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(consoleErrors, []);
  await page.close();
  await browser.close();
  browser = await chromium.launch({
    headless: true,
    args: ['--enable-webgl', '--ignore-gpu-blocklist'],
  });

  const productionPage = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const productionErrors = [];
  productionPage.on('pageerror', (error) => productionErrors.push(error.message));
  productionPage.on('console', (message) => {
    if (message.type() === 'error') productionErrors.push(message.text());
  });
  await productionPage.goto(`http://${HOST}:${PORT}/solar-voyager/`, {
    waitUntil: 'domcontentloaded',
  });
  try {
    await productionPage.waitForFunction(
      () =>
        globalThis.document.querySelector('#space-canvas[data-camera-ready="true"]') !== null,
      undefined,
      { timeout: 60_000 },
    );
  } catch (error) {
    const content = await productionPage.content();
    const canvasState = await productionPage.locator('#space-canvas').count();
    process.stderr.write(
      `${JSON.stringify(
        {
          canvasCount: canvasState,
          content: content.slice(0, 500),
          productionErrors,
          url: productionPage.url(),
        },
        null,
        2,
      )}\n`,
    );
    throw error;
  }
  const productionClip = { x: 320, y: 140, width: 640, height: 440 };
  const productionEarth = await screenshotEvidence(
    await capturePageClip(productionPage, productionClip),
  );
  await productionPage.keyboard.press('j');
  await productionPage.waitForFunction(
    () =>
      globalThis.document.querySelector('#camera-focus-label')?.textContent === 'Focus: Jupiter',
  );
  await productionPage.waitForTimeout(1_800);
  const completedFrames = await productionPage.evaluate(() => {
    const canvas = globalThis.document.querySelector('#space-canvas');
    return canvas?.solarVoyagerTelemetry?.frameSampleCount ?? 0;
  });
  await productionPage.waitForFunction(
    (previousFrames) => {
      const canvas = globalThis.document.querySelector('#space-canvas');
      return (canvas?.solarVoyagerTelemetry?.frameSampleCount ?? 0) > previousFrames;
    },
    completedFrames,
    { timeout: 60_000 },
  );
  const productionJupiter = await screenshotEvidence(
    await capturePageClip(productionPage, productionClip),
  );
  assert.notEqual(
    productionJupiter.sha256,
    productionEarth.sha256,
    'production canvas did not change after the Jupiter transfer',
  );
  assert.ok(
    productionJupiter.centerRgb.every((channel) => channel !== undefined) &&
      productionJupiter.centerRgb.reduce((sum, channel) => sum + channel, 0) > 30,
    'production Jupiter was not visible at the canvas center',
  );
  const [jupiterRed, jupiterGreen, jupiterBlue] = productionJupiter.centerRgb;
  assert.ok(
    jupiterRed > jupiterGreen + 15 && jupiterGreen > jupiterBlue + 15,
    `production center lacks Jupiter's ochre color signature (${productionJupiter.centerRgb.join(',')})`,
  );
  assert.deepEqual(productionErrors, []);

  process.stdout.write(
    `${JSON.stringify(
      {
        surfacePixelChecksum: surfaceReference.pixelChecksum,
        surfaceFrames: surfaceFrames.length,
        transferFrames: transferFrames.length,
        travelKm,
        maximumStepKm: Math.max(...smoothStepDistancesKm),
        departureStepKm: stepDistancesKm[0],
        arrivalStepKm: stepDistancesKm.at(-1),
        finalLitPixels: finalFrame.litPixels,
        productionShortcut: 'Focus: Jupiter',
        productionEarthSha256: productionEarth.sha256,
        productionJupiterCenterRgb: productionJupiter.centerRgb,
        productionJupiterSha256: productionJupiter.sha256,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  if (browser !== undefined) await browser.close();
  await server.close();
}
