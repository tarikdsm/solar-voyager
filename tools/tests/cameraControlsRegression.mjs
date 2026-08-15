import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { chromium } from 'playwright';
import sharp from 'sharp';
import { createServer } from 'vite';

import { disableUnrelatedTrajectoryPrediction } from './trajectoryPredictionTestIsolation.mjs';

const HOST = '127.0.0.1';
const PORT = 4178;
const FIXTURE_URL = `http://${HOST}:${PORT}/solar-voyager/tests/render/cameraControls.html`;
const TRANSFER_FRAMES = 90;
const TRANSFER_ZOOM_FRAME = 45;
const DELTA_SEC = 1 / 60;
// SHIP_LENGTH_M * CHASE_DEFAULT_DISTANCE_SHIP_LENGTHS * sqrt(1 + 0.35^2), in km.
const EXPECTED_CHASE_ARM_KM = 0.026_12 * 6 * Math.sqrt(1 + 0.35 * 0.35);
// WARP_LADDER = [1, 5, 10, 50, 100, 1e3, ...]; five rungs reaches 1000x.
const WARP_RUNGS = 5;
// Half of 2*pi*sqrt(r^3/mu) for r = 6,371.0084 + 400 km around Earth.
const LEO_HALF_PERIOD_SEC = 2_772;

async function readCameraDiagnostic(page) {
  return page.evaluate(() => {
    const canvas = globalThis.document.querySelector('#space-canvas');
    const camera = canvas?.solarVoyagerCamera;
    if (camera === undefined) throw new Error('camera diagnostic missing');
    return {
      armDistanceKm: camera.armDistanceKm,
      distanceShipLengths: camera.distanceShipLengths,
      focusId: camera.focusId,
      fovDeg: camera.fovDeg,
      mode: camera.mode,
      shakeAmplitudeDeg: camera.shakeAmplitudeDeg,
      shipDistanceKm: camera.shipDistanceKm,
      transitioning: camera.transitioning,
      focusLabel: globalThis.document.querySelector('#camera-focus-label')?.textContent ?? null,
      shipResolved: canvas?.solarVoyagerShip?.resolved ?? null,
      simTimeSec: canvas?.solarVoyagerSystemMap?.simulationTimeSec ?? 0,
    };
  });
}

/**
 * Records the published camera position every animation frame, inside the page.
 *
 * Polling from the test runner would sample at tens of milliseconds and could
 * not tell a smooth 1.5 s move from a cut followed by a settle; a rAF hook sees
 * every frame the director actually produced.
 *
 * `keyToDispatch` is delivered from *inside* the page on the first sampled
 * frame. Pressing it over CDP instead raced the recording: the key could land
 * before the sampler started or near the end of its window, so the same run
 * would sometimes measure a slice of the move rather than all of it. This is the
 * pattern `tools/bench/flightBench.mjs` already uses for its focus events.
 */
async function recordCameraPath(page, durationMs, keyToDispatch = null) {
  return page.evaluate(
    async ([windowMs, key]) => {
      const canvas = globalThis.document.querySelector('#space-canvas');
      const camera = canvas?.solarVoyagerCamera;
      if (camera === undefined) throw new Error('camera diagnostic missing');
      const samples = [];
      const deadline = globalThis.performance.now() + windowMs;
      let dispatched = key === null;
      await new Promise((resolve) => {
        const sample = () => {
          samples.push([
            camera.positionXKm,
            camera.positionYKm,
            camera.positionZKm,
            camera.shipDistanceKm,
            globalThis.performance.now(),
          ]);
          if (!dispatched) {
            dispatched = true;
            globalThis.dispatchEvent(new globalThis.KeyboardEvent('keydown', { key }));
          }
          if (globalThis.performance.now() >= deadline) resolve();
          else globalThis.requestAnimationFrame(sample);
        };
        globalThis.requestAnimationFrame(sample);
      });
      return samples;
    },
    [durationMs, keyToDispatch],
  );
}

/**
 * Describes one recorded camera path.
 *
 * Kilometres per frame is deliberately **not** the continuity yardstick for a
 * mode change. The blend interpolates distance logarithmically (see
 * `game/cameraTransition.ts`), so a constant *visual* rate of change — a
 * constant number of e-foldings per second, which is what the eye reads — is by
 * construction an exploding linear speed when the two ends are 166 m and
 * 19,113 km apart. Judging it in km/frame would flag the correct behaviour.
 *
 * What actually distinguishes a blend from a cut is the **shape**: a cut is one
 * enormous step with near-zero neighbours, over in a single frame. So the
 * summary reports the largest step relative to its own neighbours, and the wall
 * time the motion is spread across.
 */
function summarizePath(samples) {
  const stepsKm = [];
  let maximumStepKm = 0;
  let maximumStepIndex = -1;
  let pathLengthKm = 0;
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const current = samples[index];
    const stepKm = Math.hypot(
      current[0] - previous[0],
      current[1] - previous[1],
      current[2] - previous[2],
    );
    stepsKm.push(stepKm);
    pathLengthKm += stepKm;
    if (stepKm > maximumStepKm) {
      maximumStepKm = stepKm;
      maximumStepIndex = index;
    }
  }
  // Wall time spanned by the middle 90 % of the path length.
  let cumulativeKm = 0;
  let movementStartMs = null;
  let movementEndMs = null;
  for (let index = 0; index < stepsKm.length; index += 1) {
    cumulativeKm += stepsKm[index];
    const fraction = pathLengthKm === 0 ? 0 : cumulativeKm / pathLengthKm;
    if (movementStartMs === null && fraction >= 0.05) movementStartMs = samples[index][4];
    if (movementEndMs === null && fraction >= 0.95) movementEndMs = samples[index + 1][4];
  }
  const beforeMaximumKm = stepsKm[maximumStepIndex - 2] ?? 0;
  const afterMaximumKm = stepsKm[maximumStepIndex] ?? 0;
  const first = samples[0];
  const last = samples.at(-1);
  return {
    aroundMaximumKm: stepsKm.slice(Math.max(0, maximumStepIndex - 4), maximumStepIndex + 4),
    maximumStepKm,
    maximumStepIndex,
    // A blend has neighbours of the same order as its peak; a cut has none.
    maximumStepNeighbourRatio:
      maximumStepKm / Math.max(1e-9, (beforeMaximumKm + afterMaximumKm) / 2),
    movementSpanMs: movementStartMs === null || movementEndMs === null
      ? 0
      : movementEndMs - movementStartMs,
    pathLengthKm,
    sampleCount: samples.length,
    shipDistanceFirstKm: first[3],
    shipDistanceLastKm: last[3],
    travelKm: Math.hypot(last[0] - first[0], last[1] - first[1], last[2] - first[2]),
    windowFps: (samples.length - 1) / ((last[4] - first[4]) / 1_000),
  };
}

async function readPointerLockState(page) {
  return page.evaluate(() => ({
    locked: globalThis.document.pointerLockElement?.id ?? null,
    pauseRequests:
      globalThis.document.querySelector('#space-canvas')?.dataset.pauseRequests ?? null,
  }));
}

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
  const regionStartX = Math.floor(info.width * 0.3);
  const regionEndX = Math.floor(info.width * 0.7);
  const regionStartY = Math.floor(info.height * 0.2);
  const regionEndY = Math.floor(info.height * 0.4);
  let warmRed = 0;
  let warmGreen = 0;
  let warmBlue = 0;
  let warmSamples = 0;
  for (let y = regionStartY; y < regionEndY; y += 1) {
    for (let x = regionStartX; x < regionEndX; x += 1) {
      const offset = (y * info.width + x) * info.channels;
      const red = data[offset];
      const green = data[offset + 1];
      const blue = data[offset + 2];
      if (red === undefined || green === undefined || blue === undefined || red + green + blue < 45) {
        continue;
      }
      warmRed += red;
      warmGreen += green;
      warmBlue += blue;
      warmSamples += 1;
    }
  }
  return {
    centerRgb: [data[centerOffset], data[centerOffset + 1], data[centerOffset + 2]],
    sha256: createHash('sha256').update(buffer).digest('hex'),
    upperCenterMeanRgb: [warmRed, warmGreen, warmBlue].map((sum) => sum / warmSamples),
    upperCenterSamples: warmSamples,
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
  await disableUnrelatedTrajectoryPrediction(productionPage);
  const productionErrors = [];
  productionPage.on('pageerror', (error) => productionErrors.push(error.message));
  productionPage.on('console', (message) => {
    if (message.type() === 'error') productionErrors.push(message.text());
  });
  await productionPage.goto(`http://${HOST}:${PORT}/solar-voyager/?autostart=1`, {
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

  // ---------------------------------------------------------------- T0110 ---
  // The shipped game starts third-person. Everything below the Jupiter phase
  // used to assume the camera opened on Earth; it now has to reach observatory
  // deliberately, which is itself the coverage this task needs.
  const chaseStart = await readCameraDiagnostic(productionPage);
  assert.equal(chaseStart.mode, 'chase', 'the shipped game did not start in the chase camera');
  assert.equal(chaseStart.focusId, 'ship');
  assert.equal(chaseStart.focusLabel, 'Focus: Ship');
  assert.equal(chaseStart.distanceShipLengths, 6);
  assert.ok(
    Math.abs(chaseStart.shipDistanceKm - EXPECTED_CHASE_ARM_KM) < 1e-6,
    `chase arm is not d*sqrt(1+0.35^2) behind the ship: ${String(chaseStart.shipDistanceKm)}`,
  );

  // Does it actually follow? Warp the ship most of the way around Earth — tens
  // of thousands of kilometres of travel — and check the arm is still exactly
  // where it belongs, with the hull still resolved.
  for (let press = 0; press < WARP_RUNGS; press += 1) await productionPage.keyboard.press('Equal');
  await productionPage.waitForFunction(
    (deadlineSec) =>
      (globalThis.document.querySelector('#space-canvas')?.solarVoyagerSystemMap
        ?.simulationTimeSec ?? 0) >= deadlineSec,
    chaseStart.simTimeSec + LEO_HALF_PERIOD_SEC,
    { timeout: 180_000 },
  );
  for (let press = 0; press < WARP_RUNGS; press += 1) await productionPage.keyboard.press('Minus');
  await productionPage.waitForTimeout(1_500);
  const chaseAfterWarp = await readCameraDiagnostic(productionPage);
  assert.equal(chaseAfterWarp.mode, 'chase');
  assert.ok(
    chaseAfterWarp.simTimeSec - chaseStart.simTimeSec >= LEO_HALF_PERIOD_SEC,
    'the warp did not advance the simulation',
  );
  assert.ok(
    Math.abs(chaseAfterWarp.shipDistanceKm - EXPECTED_CHASE_ARM_KM) < 1e-3,
    `the camera lost the ship over half an orbit: ${String(chaseAfterWarp.shipDistanceKm)} km`,
  );
  assert.equal(chaseAfterWarp.shipResolved, true, 'the chased ship is not resolved');

  // Coasting: no throttle, no acceleration, so neither effect may be running.
  assert.equal(chaseAfterWarp.shakeAmplitudeDeg, 0);
  assert.ok(
    Math.abs(chaseAfterWarp.fovDeg - 75) < 1e-6,
    `coasting widened the field of view: ${String(chaseAfterWarp.fovDeg)}`,
  );

  const chasePath = summarizePath(await recordCameraPath(productionPage, 1_000));
  assert.ok(chasePath.sampleCount > 10, 'the frame loop is not running');

  // Mode change: animated, never a cut.
  const transitionPath = summarizePath(await recordCameraPath(productionPage, 3_000, 'o'));
  const observatory = await readCameraDiagnostic(productionPage);
  assert.equal(observatory.mode, 'observatory');
  assert.equal(observatory.focusId, 'earth');
  assert.equal(observatory.focusLabel, 'Focus: Earth');
  assert.equal(observatory.transitioning, false);
  assert.ok(
    transitionPath.travelKm > 1_000,
    `the mode change did not move the camera: ${String(transitionPath.travelKm)} km`,
  );
  // Not a cut: the move is spread over hundreds of milliseconds and its busiest
  // frame has busy neighbours. A hard cut is a single frame carrying the whole
  // distance between two stationary stretches.
  assert.ok(
    transitionPath.movementSpanMs > 250,
    `the chase-to-observatory change happened too fast to be a blend: ${JSON.stringify(
      transitionPath,
    )}`,
  );
  assert.ok(
    transitionPath.maximumStepNeighbourRatio < 5,
    `the chase-to-observatory change cut instead of blending: ${JSON.stringify(transitionPath)}`,
  );

  await productionPage.keyboard.press('o');
  await productionPage.waitForTimeout(2_500);
  const backToChase = await readCameraDiagnostic(productionPage);
  assert.equal(backToChase.mode, 'chase');
  assert.equal(backToChase.focusLabel, 'Focus: Ship');

  // Return to the v1 arrangement for the Jupiter phase below, which is about the
  // observatory camera's focus transfer and predates this task.
  await productionPage.keyboard.press('e');
  await productionPage.waitForFunction(
    () => globalThis.document.querySelector('#camera-focus-label')?.textContent === 'Focus: Earth',
  );
  await productionPage.waitForTimeout(2_000);
  // ------------------------------------------------------------ end T0110 ---

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
    return canvas?.solarVoyagerTelemetry?.snapshot.frameCount ?? 0;
  });
  await productionPage.waitForFunction(
    (previousFrames) => {
      const canvas = globalThis.document.querySelector('#space-canvas');
      return (canvas?.solarVoyagerTelemetry?.snapshot.frameCount ?? 0) > previousFrames;
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
  const [jupiterRed, jupiterGreen, jupiterBlue] = productionJupiter.upperCenterMeanRgb;
  assert.ok(
    productionJupiter.upperCenterSamples > 10_000 &&
      jupiterRed > jupiterGreen + 3 &&
      jupiterGreen > jupiterBlue + 3,
    `production disc lacks Jupiter's ochre color signature (${productionJupiter.upperCenterMeanRgb.join(',')})`,
  );
  // T0105 pointer-lock seam: double-click takes the lock, Escape releases it and
  // raises the pause intent that T0112 will turn into a real menu.
  const pointerLockBefore = await readPointerLockState(productionPage);
  assert.equal(pointerLockBefore.locked, null, 'pointer lock was held before any gesture');
  await productionPage.mouse.dblclick(640, 360);
  await productionPage.waitForFunction(
    () => globalThis.document.pointerLockElement !== null,
    undefined,
    { timeout: 10_000 },
  );
  const pointerLockAcquired = await readPointerLockState(productionPage);
  assert.equal(
    pointerLockAcquired.locked,
    'space-canvas',
    'double-click did not take pointer lock on the canvas',
  );
  await productionPage.keyboard.press('Escape');
  await productionPage.waitForFunction(
    () => globalThis.document.pointerLockElement === null,
    undefined,
    { timeout: 10_000 },
  );
  const pointerLockReleased = await readPointerLockState(productionPage);
  assert.equal(pointerLockReleased.locked, null, 'Escape did not release pointer lock');
  assert.equal(
    pointerLockReleased.pauseRequests,
    String(Number(pointerLockAcquired.pauseRequests ?? '0') + 1),
    'Escape did not raise exactly one pause request',
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
        chaseStart,
        chaseAfterWarp,
        chasePath,
        transitionPath,
        observatoryAfterModeChange: observatory,
        backToChase,
        productionShortcut: 'Focus: Jupiter',
        pointerLockAcquired: pointerLockAcquired.locked,
        pointerLockReleased: pointerLockReleased.locked,
        pauseRequestsAfterEscape: pointerLockReleased.pauseRequests,
        productionEarthSha256: productionEarth.sha256,
        productionJupiterCenterRgb: productionJupiter.centerRgb,
        productionJupiterUpperCenterMeanRgb: productionJupiter.upperCenterMeanRgb,
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
