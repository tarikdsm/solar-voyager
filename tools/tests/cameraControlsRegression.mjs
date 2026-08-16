import assert from 'node:assert/strict';

import { chromium } from 'playwright';
import { createServer } from 'vite';

import { BLEND_FRAME_COST } from './cameraWaits.mjs';
import { disableUnrelatedTrajectoryPrediction } from './trajectoryPredictionTestIsolation.mjs';

/**
 * The camera gate: what a real browser proves about the chase camera that a
 * unit test structurally cannot, and nothing else.
 *
 * Seven CI rounds on this one file, across four distinct infrastructure root
 * causes, and zero product defects: a frame rate treated as a correctness
 * proxy; a wall-clock-only timeout that was really a frame-rate assumption
 * wearing a different hat; a since-removed fixture phase with roughly 124
 * `page.evaluate()` calls that carry no timeout of their own (Playwright
 * hard-codes `kNoTimeout` for `evaluate`); a `page.screenshot()`-class CDP
 * capture on the critical path. Then, on the very next real CI run after all
 * of that was fixed, the mode-transition wait — already bounded in both
 * frames and wall clock — passed once at 22.4 s and hung to an 8-minute kill
 * on the next attempt. Not a bug in the wait's bounds; the underlying
 * render-gated work is a coin flip at CI's performance floor. The chase
 * camera itself has never once been wrong. A smaller gate that is
 * trustworthy beats a comprehensive one that cries wolf.
 *
 * What stays, because only a real renderer can prove it and neither property
 * has ever failed in seven rounds:
 *   1. Chase is the default camera in the shipped game, reached via
 *      `?autostart=1` with no input.
 *   2. The chase arm holds `d*sqrt(1+0.35^2)` on every rendered frame while
 *      the ship actually moves — warped 600 s of simulated flight, then
 *      sampled across a dozen real animation frames.
 *
 * What this gate deliberately no longer covers, and exactly where each
 * property now lives — read this before re-adding a render-gated phase here:
 *   - The mode-transition blend's shape, continuity and every numeric bound:
 *     `src/game/cameraDirector.test.ts`, at an exact deterministic 1/60 s
 *     frame delta instead of whatever a contended software rasteriser
 *     manages. "cycles chase and observatory" covers the mode and focus-id
 *     transition itself; "never takes a discontinuous step, even across
 *     4 AU" and "spends the whole blend duration moving, with no isolated
 *     spike" cover the blend's shape and continuity.
 *   - The keypress -> mode/focus mapping and the focus-label DOM write:
 *     `src/ui/cameraInputController.test.ts`. "cycles the camera mode on O
 *     and relabels from the camera, not the key" and "supports target
 *     cycling and direct Earth/Jupiter shortcuts" drive the same
 *     `CameraInputController` the browser did, synchronously, with no
 *     renderer involved.
 *   - Pointer lock acquire/release: covered only in part, deliberately, not
 *     by oversight. `src/game/input/inputEngine.test.ts`
 *     ("InputEngine — pointer lock") covers the logic — exactly one pause
 *     request per Escape or per unrequested lock loss, none on a requested
 *     release — against a fake `PointerLockSurface`. What nothing in this
 *     repo covers, after this cut, is whether a real mouse gesture actually
 *     acquires the browser's own Pointer Lock API
 *     (`main.ts`'s `createCanvasPointerLockSurface`) or whether
 *     `document.pointerLockElement` genuinely reflects it. That is a real,
 *     recorded loss of coverage, not a redundancy removed.
 *
 * Removed in earlier rounds for cost, not redundancy: a pre-T0110 fixture
 * phase driving `OrbitCameraController` directly (redundant with
 * `orbitCameraController.test.ts`) and two production screenshots evidencing
 * Jupiter's colour (`docs/bench/T0110-chase-earth.png` is the visual proof
 * instead). See this file's git history for those rounds' full reasoning.
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
    async ({ maxSamples, minSamples, timeoutMs }) => {
      const canvas = globalThis.document.querySelector('#space-canvas');
      const camera = canvas?.solarVoyagerCamera;
      if (camera === undefined) throw new Error('camera diagnostic missing');
      const samples = [];
      const startedMs = globalThis.performance.now();
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

  assert.deepEqual(productionErrors, []);
  logPhase('all phases done');

  process.stdout.write(
    `${JSON.stringify(
      {
        chaseStart,
        chaseAfterWarp,
        chasePath,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  if (browser !== undefined) await browser.close();
  await server.close();
}
