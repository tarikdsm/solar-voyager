import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { chromium } from 'playwright';
import sharp from 'sharp';
import { createServer } from 'vite';

import { BLEND_FRAME_COST, waitForCameraMode } from './cameraWaits.mjs';
import { disableUnrelatedTrajectoryPrediction } from './trajectoryPredictionTestIsolation.mjs';

/**
 * What a real browser uniquely proves about the chase camera, and nothing else.
 *
 * This gate used to also drive a synthetic fixture scene through
 * `OrbitCameraController` directly (surface-skim jitter, an Earth-to-Jupiter
 * transfer) before ever touching the shipped app. That coverage was real but
 * redundant: `src/game/orbitCameraController.test.ts` ("has no numerical
 * jitter on repeated surface-skimming frames", using the same
 * `zoomByWheel(-1_000_000)` / `orbitBy(0.731, 0.419)` inputs) checks the same
 * property bit-exactly across 2,000 frames instead of 30, and
 * `src/game/cameraDirector.test.ts` ("never takes a discontinuous step, even
 * across 4 AU") holds the same `travelKm * 0.04` bound this gate used to
 * measure from ~20 ragged samples. It also cost ~124 `page.evaluate()` calls
 * with no timeout of their own — Playwright hard-codes `kNoTimeout` for
 * `evaluate`, so a single stalled call there hangs forever with no diagnostic,
 * which is a plausible source of the zero-output, 8-minute-timeout failures
 * this file used to produce. Removed, not weakened: every property either has
 * an exact deterministic home already or was never anything but "a real
 * renderer drew pixels", which the sections below still prove.
 *
 * What stays is only what a real renderer *uniquely* proves and a unit test
 * cannot: that chase is the default camera in the shipped game reached via
 * `?autostart=1`, that the chase arm holds `d*sqrt(1+0.35^2)` on every
 * rendered frame while the ship actually moves, and a handful of cheap,
 * already-passing checks (the Jupiter focus label, pointer lock) that are not
 * camera-motion dependent.
 */

const HOST = '127.0.0.1';
const PORT = 4178;
// SHIP_LENGTH_M * CHASE_DEFAULT_DISTANCE_SHIP_LENGTHS * sqrt(1 + 0.35^2), in km.
const EXPECTED_CHASE_ARM_KM = 0.026_12 * 6 * Math.sqrt(1 + 0.35 * 0.35);
// WARP_LADDER = [1, 5, 10, 50, 100, 1e3, ...]; five rungs reaches 1000x.
const WARP_RUNGS = 5;
/**
 * Simulated seconds the ship must cover before the arm is re-checked.
 *
 * 600 s of LEO is about 39 degrees of arc and 4,340 km of travel — still a
 * "the ship went a very long way and the camera held" claim, but six rendered
 * frames at 1000x instead of the twenty-eight a half-orbit cost. Frames are the
 * scarce resource in this gate (see `cameraWaits.mjs`), so the coverage is kept
 * and the frame bill is not.
 */
const WARP_TRAVEL_SIM_SEC = 600;

const gateStartMs = Date.now();
/**
 * Prints one line per phase boundary with the wall time elapsed so far.
 *
 * Before this, the gate printed nothing until a single JSON blob at the very
 * end, so a run killed by the step timeout said nothing about how far it got.
 * Four rounds of diagnosing CI timeouts on this file were slower than they
 * needed to be because of exactly that silence — this is the fix for that,
 * independent of anything else in this file.
 */
function logPhase(message) {
  const elapsedSec = ((Date.now() - gateStartMs) / 1_000).toFixed(1);
  process.stdout.write(`[camera-gate +${elapsedSec}s] ${message}\n`);
}

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
 *
 * It stops on a **condition**, never on a wall-clock window. The first version of
 * this helper sampled for a fixed 1,000 ms and the caller then asserted it had
 * collected more than ten frames, which is a 10 fps floor written as if it were a
 * correctness check: on a contended software rasteriser fewer frames render in
 * the window and the gate failed for no reason. A slow renderer must make this
 * take longer, not fail.
 *
 * @param minSamples frames the caller needs before any conclusion is possible
 * @param maxSamples frame budget — patience in the unit the renderer spends
 * @param timeoutMs wall cap. Not redundant with the frame budget: 60 frames at
 *   0.3 fps is three minutes, and this step has to fail inside its
 *   `timeout-minutes` with a diagnostic rather than be killed without one.
 *   Whichever bound trips is reported.
 */
async function recordCameraPath(page, options) {
  return page.evaluate(
    async ({ keyToDispatch, maxSamples, minSamples, timeoutMs }) => {
      const canvas = globalThis.document.querySelector('#space-canvas');
      const camera = canvas?.solarVoyagerCamera;
      if (camera === undefined) throw new Error('camera diagnostic missing');
      const samples = [];
      const startedMs = globalThis.performance.now();
      let dispatched = keyToDispatch === null;
      let timedOut = null;
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
            globalThis.dispatchEvent(
              new globalThis.KeyboardEvent('keydown', { key: keyToDispatch }),
            );
          }
          if (samples.length >= maxSamples) {
            timedOut = 'frame-budget';
            resolve();
          } else if (globalThis.performance.now() - startedMs >= timeoutMs) {
            timedOut = 'wall-cap';
            resolve();
          } else if (samples.length >= minSamples) resolve();
          else globalThis.requestAnimationFrame(sample);
        };
        globalThis.requestAnimationFrame(sample);
      });
      return {
        elapsedMs: globalThis.performance.now() - startedMs,
        samples,
        timedOut,
      };
    },
    {
      keyToDispatch: options.keyToDispatch ?? null,
      maxSamples: options.maxSamples ?? 60,
      minSamples: options.minSamples,
      timeoutMs: options.timeoutMs ?? 30_000,
    },
  );
}

/**
 * Describes one recorded camera path.
 *
 * Deliberately does *not* try to characterise a mode blend. Kilometres per frame
 * is the wrong yardstick for one — the blend interpolates distance
 * logarithmically, so a constant visual rate of change is by construction an
 * exploding linear speed across a 166 m to 19,113 km move — and the shape that
 * does distinguish a blend from a cut is measured accurately only at a
 * deterministic frame delta. That lives in `src/game/cameraDirector.test.ts`.
 *
 * What this describes is a **hold**: the camera tracking a moving ship, where
 * every sample should sit at the same arm length.
 */
function summarizePath(recording, label) {
  const { elapsedMs, samples, timedOut } = recording;
  const fps = elapsedMs > 0 ? (samples.length / elapsedMs) * 1_000 : 0;
  assert.equal(
    timedOut,
    null,
    timedOut === 'frame-budget'
      ? `${label}: the app rendered ${String(samples.length)} frames without reaching the ` +
        `condition (a blend needs ${String(BLEND_FRAME_COST)}), so this is the app, not the ` +
        `runner — ${fps.toFixed(2)} fps`
      : `${label}: the wall cap tripped after only ${String(samples.length)} frames in ` +
        `${String(Math.round(elapsedMs))} ms (${fps.toFixed(2)} fps); a blend needs ` +
        `${String(BLEND_FRAME_COST)} frames, so this is the runner being slow or stopped`,
  );
  assert.ok(
    samples.length >= 2,
    `${label}: need at least two rendered frames to describe a path, got ${String(samples.length)}`,
  );
  let maximumStepKm = 0;
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const current = samples[index];
    maximumStepKm = Math.max(
      maximumStepKm,
      Math.hypot(current[0] - previous[0], current[1] - previous[1], current[2] - previous[2]),
    );
  }
  const first = samples[0];
  const last = samples.at(-1);
  return {
    elapsedMs: Math.round(elapsedMs),
    maximumStepKm,
    observedFps: Number(fps.toFixed(2)),
    sampleCount: samples.length,
    shipDistanceFirstKm: first[3],
    shipDistanceLastKm: last[3],
    travelKm: Math.hypot(last[0] - first[0], last[1] - first[1], last[2] - first[2]),
  };
}

/**
 * Waits for the HUD focus label, reporting what it actually said on failure.
 *
 * A bare `waitForFunction` on a string comparison times out saying only that it
 * timed out, which is useless when the interesting information is the string.
 */
async function waitForFocusLabel(page, expected, timeoutMs = 25_000) {
  try {
    await page.waitForFunction(
      (text) => globalThis.document.querySelector('#camera-focus-label')?.textContent === text,
      expected,
      { timeout: timeoutMs },
    );
  } catch (cause) {
    const state = await page.evaluate(() => {
      const canvas = globalThis.document.querySelector('#space-canvas');
      return {
        activeElement: globalThis.document.activeElement?.tagName ?? null,
        focusId: canvas?.solarVoyagerCamera?.focusId ?? null,
        label: globalThis.document.querySelector('#camera-focus-label')?.textContent ?? null,
        mode: canvas?.solarVoyagerCamera?.mode ?? null,
        systemMapMode: canvas?.dataset.systemMapMode ?? null,
        transitioning: canvas?.solarVoyagerCamera?.transitioning ?? null,
      };
    });
    throw new Error(`the focus label never became "${expected}": ${JSON.stringify(state)}`, {
      cause,
    });
  }
}

async function readPointerLockState(page) {
  return page.evaluate(() => ({
    locked: globalThis.document.pointerLockElement?.id ?? null,
    pauseRequests:
      globalThis.document.querySelector('#space-canvas')?.dataset.pauseRequests ?? null,
  }));
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
  logPhase('dev server up');
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
  logPhase('production page loaded');
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
  logPhase('camera ready');
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
  logPhase('chase confirmed as the default camera (?autostart=1, no input)');

  // Does it actually follow? Warp the ship thousands of kilometres along its
  // orbit and check the arm is still exactly where it belongs, hull resolved.
  for (let press = 0; press < WARP_RUNGS; press += 1) await productionPage.keyboard.press('Equal');
  await productionPage.waitForFunction(
    (deadlineSec) =>
      (globalThis.document.querySelector('#space-canvas')?.solarVoyagerSystemMap
        ?.simulationTimeSec ?? 0) >= deadlineSec,
    chaseStart.simTimeSec + WARP_TRAVEL_SIM_SEC,
    { timeout: 60_000 },
  );
  for (let press = 0; press < WARP_RUNGS; press += 1) await productionPage.keyboard.press('Minus');
  await productionPage.waitForTimeout(1_500);
  const chaseAfterWarp = await readCameraDiagnostic(productionPage);
  assert.equal(chaseAfterWarp.mode, 'chase');
  assert.ok(
    chaseAfterWarp.simTimeSec - chaseStart.simTimeSec >= WARP_TRAVEL_SIM_SEC,
    'the warp did not advance the simulation',
  );
  assert.ok(
    Math.abs(chaseAfterWarp.shipDistanceKm - EXPECTED_CHASE_ARM_KM) < 1e-3,
    `the camera lost the ship over 4,000 km of travel: ${String(chaseAfterWarp.shipDistanceKm)} km`,
  );
  assert.equal(chaseAfterWarp.shipResolved, true, 'the chased ship is not resolved');

  // Coasting: no throttle, no acceleration, so neither effect may be running.
  assert.equal(chaseAfterWarp.shakeAmplitudeDeg, 0);
  assert.ok(
    Math.abs(chaseAfterWarp.fovDeg - 75) < 1e-6,
    `coasting widened the field of view: ${String(chaseAfterWarp.fovDeg)}`,
  );
  logPhase(
    `warped ${String(Math.round(chaseAfterWarp.simTimeSec - chaseStart.simTimeSec))}s of sim time, arm still holds`,
  );

  // Holds the arm every frame, not just at the two ends. Waits for the frames it
  // needs rather than asserting a frame rate.
  const chaseRecording = await recordCameraPath(productionPage, {
    maxSamples: 60,
    minSamples: 12,
    timeoutMs: 30_000,
  });
  const chasePath = summarizePath(chaseRecording, 'chase hold');
  for (const [index, sample] of chaseRecording.samples.entries()) {
    assert.ok(
      Math.abs(sample[3] - EXPECTED_CHASE_ARM_KM) < 1e-3,
      `chase arm drifted on frame ${String(index)}: ${String(sample[3])} km`,
    );
  }
  logPhase(
    `${String(chaseRecording.samples.length)} frames recorded, arm invariant held on every one`,
  );

  // The mode change is *waited on* here, not recorded.
  //
  // The shape of the blend — that it is animated rather than cut, spends the
  // whole 1.5 s window moving, and never takes a discontinuous step — lives in
  // `src/game/cameraDirector.test.ts` ("never takes a discontinuous step, even
  // across 4 AU", "spends the whole blend duration moving, with no isolated
  // spike", "reverses mid-transition without cutting"). That is not a weaker
  // home for it, it is the accurate one: the frame delta there is exactly 1/60,
  // so those tests count all 90 frames of the move and bound the largest step at
  // 4 % of travel, where this gate could only infer "spread over more than
  // 250 ms" from a score of ragged samples at 3-5 fps.
  //
  // What a browser uniquely proves is what stays: that the key reaches the
  // shipped app, that the mode and focus label follow it, and — above — that the
  // arm holds on every rendered frame while the ship really moves.
  await productionPage.keyboard.press('o');
  await waitForCameraMode(productionPage, 'observatory');
  const observatory = await readCameraDiagnostic(productionPage);
  assert.equal(observatory.mode, 'observatory');
  assert.equal(observatory.focusId, 'earth');
  assert.equal(observatory.focusLabel, 'Focus: Earth');
  assert.equal(observatory.transitioning, false);
  assert.ok(
    observatory.shipDistanceKm > 1_000,
    `the mode change did not move the camera off the ship: ${String(
      observatory.shipDistanceKm,
    )} km`,
  );
  logPhase('mode transition to observatory verified (keypress -> mode -> focus label)');
  // ------------------------------------------------------------ end T0110 ---

  const productionEarth = await screenshotEvidence(
    await capturePageClip(productionPage, productionClip),
  );
  await productionPage.keyboard.press('j');
  await waitForFocusLabel(productionPage, 'Focus: Jupiter');
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
  logPhase('Jupiter focus label and screenshot evidence verified');

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
  logPhase('pointer lock acquire/release verified');

  assert.deepEqual(productionErrors, []);
  logPhase('all phases done');

  process.stdout.write(
    `${JSON.stringify(
      {
        chaseStart,
        chaseAfterWarp,
        chasePath,
        observatoryAfterModeChange: observatory,
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
