import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { chromium } from 'playwright';
import { createServer, preview } from 'vite';

import { assertPortAvailable } from '../bench/scaffoldBenchUtils.mjs';
import { waitForCameraMode } from './cameraWaits.mjs';
import { disableUnrelatedTrajectoryPrediction } from './trajectoryPredictionTestIsolation.mjs';
import { resolveHarnessPort } from '../harnessPort.mjs';

const HOST = '127.0.0.1';
const FIXTURE_PORT = resolveHarnessPort(4203);
const PRODUCTION_PORT = resolveHarnessPort(4204);
const FIXTURE_URL = `http://${HOST}:${String(FIXTURE_PORT)}/solar-voyager/tests/render/shipVisual.html`;
const PRODUCTION_URL = `http://${HOST}:${String(PRODUCTION_PORT)}/solar-voyager/?autostart=1`;
const CAPTURE_FLAG_INDEX = process.argv.indexOf('--capture');
const CAPTURE_PATH =
  CAPTURE_FLAG_INDEX < 0 ? null : path.resolve(process.argv[CAPTURE_FLAG_INDEX + 1] ?? '');
// The ship is the last catalog target, so `]` from it wraps onto the Sun (index
// 0) and a single `[` wraps straight back onto the ship.
const FOCUS_CYCLE_BACKWARD_PRESSES = 1;
const NOSE_ALIGNMENT_TOLERANCE = 1e-6;
// WARP_LADDER = [1, 5, 10, 50, 100, 1e3, ...]; five rungs reaches 1000x.
const WARP_RUNGS_FOR_CAPTURE = 5;
// Half of 2*pi*sqrt(r^3/mu) for r = 6,371.0084 + 400 km around Earth.
const LEO_HALF_PERIOD_SEC = 2_772;

function collectBrowserErrors(page) {
  const errors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('crash', () => errors.push('page crash'));
  return errors;
}

function assertNoGlError(snapshot, label) {
  assert.equal(snapshot.glError, 0, `${label}: WebGL error ${String(snapshot.glError)}`);
}

function assertAligned(value, label) {
  assert.ok(
    Math.abs(value - 1) <= NOSE_ALIGNMENT_TOLERANCE,
    `${label}: rendered nose is not the physics forward (cos = ${String(value)})`,
  );
}

/**
 * Fixture phase: the tier ladder, the attitude coupling against the real
 * `ship.glb`, and the sunlit/backlit ordering, all with pixel readback.
 */
async function runFixturePhase(browser) {
  const page = await browser.newPage({ viewport: { width: 256, height: 256 } });
  const requests = [];
  const browserErrors = collectBrowserErrors(page);
  page.on('request', (request) => requests.push(request.url()));

  try {
    await page.goto(FIXTURE_URL, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => globalThis.__shipVisualHarness !== undefined);

    const shipModelRequests = () =>
      requests.filter((url) => /\/models\/ship(?:_[12]k)?\.glb$/u.test(new URL(url).pathname));
    assert.equal(shipModelRequests().length, 0, 'ship model fetched before the ship resolved');

    const distanceFor = async (diameterPx) =>
      page.evaluate(
        (value) => globalThis.__shipVisualHarness.distanceForDiameterPx(value),
        diameterPx,
      );
    const step = async (distanceKm, side, nowMs) =>
      page.evaluate(
        ([distance, viewSide, now]) =>
          globalThis.__shipVisualHarness.step(distance, viewSide, now),
        [distanceKm, side, nowMs],
      );

    const pointDistanceKm = await distanceFor(1);
    const bandDistanceKm = await distanceFor(1.5);
    const resolvedDistanceKm = await distanceFor(2.5);
    const closeDistanceKm = await distanceFor(90);

    const farPoint = await step(await distanceFor(0.05), 'sunward', 0);
    assertNoGlError(farPoint, 'far point');
    assert.equal(farPoint.resolved, false);
    assert.equal(farPoint.loadState, 'idle');
    assert.equal(farPoint.pointOpacity, 1);
    assert.equal(farPoint.modelOpacity, 0);
    assert.equal(shipModelRequests().length, 0, 'unresolved ship fetched its model');

    const belowThreshold = await step(pointDistanceKm, 'sunward', 16);
    assert.equal(belowThreshold.resolved, false);
    const insideBand = await step(bandDistanceKm, 'sunward', 32);
    assert.equal(insideBand.resolved, false, 'hysteresis band resolved on the way in');

    const resolving = await step(resolvedDistanceKm, 'sunward', 48);
    assert.equal(resolving.resolved, true);
    assert.equal(resolving.modelOpacity, 0, 'model revealed before it finished compiling');
    await page.waitForFunction(
      () => globalThis.__shipVisualHarness.snapshotState().loadState === 'ready',
      undefined,
      { timeout: 60_000 },
    );
    assert.equal(shipModelRequests().length, 1, 'resolved ship did not fetch exactly one model');

    const backInBand = await step(bandDistanceKm, 'sunward', 64);
    assert.equal(backInBand.resolved, true, 'hysteresis band dropped the model on the way out');

    await step(closeDistanceKm, 'sunward', 80);
    const litClose = await step(closeDistanceKm, 'sunward', 400);
    assertNoGlError(litClose, 'sunlit close');
    assert.equal(litClose.modelOpacity, 1);
    assert.equal(litClose.pointOpacity, 0);
    assert.ok(litClose.triangles > 0, 'resolved ship drew no triangles');
    assert.ok(
      litClose.litPixels > 300,
      `sunlit ship covers too little of the frame: ${JSON.stringify(litClose)}`,
    );

    const backlit = await step(closeDistanceKm, 'antisunward', 500);
    assertNoGlError(backlit, 'backlit close');
    // Illuminated coverage, not mean luminance: the nozzle's emissive texture is
    // view-independent and saturates a handful of pixels in both views, which
    // would swamp a mean over a mostly black frame.
    assert.ok(
      litClose.litPixels > backlit.litPixels * 1.2,
      `the anti-sunward face is not darker than the sunlit face: ${JSON.stringify({ backlit, litClose })}`,
    );
    assert.ok(
      backlit.litPixels > 0,
      'the backlit hull vanished completely; ambient sky lighting is missing',
    );

    const attitudes = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
      [-1, 0, 0],
      [0.3, -0.7, 0.648_074_07],
    ];
    const attitudeSamples = [];
    let nowMs = 600;
    for (const [x, y, z] of attitudes) {
      await page.evaluate(
        ([forwardX, forwardY, forwardZ]) =>
          globalThis.__shipVisualHarness.setForward(forwardX, forwardY, forwardZ),
        [x, y, z],
      );
      nowMs += 100;
      const sample = await step(closeDistanceKm, 'sunward', nowMs);
      assertNoGlError(sample, `attitude ${String([x, y, z])}`);
      assertAligned(sample.noseAlignment, `attitude ${String([x, y, z])} composed`);
      assertAligned(sample.noseNodeAlignment, `attitude ${String([x, y, z])} asset node`);
      attitudeSamples.push({ forward: [x, y, z], ...sample });
    }

    assert.deepEqual(browserErrors, []);
    return { attitudeSamples, backlit, farPoint, litClose, resolving };
  } finally {
    await page.close();
  }
}

/**
 * Production phase: the shipped game opens on the ship and the focus ring still
 * walks off it and back.
 *
 * T0109 shipped this phase against a camera that started on Earth with the ship
 * sub-pixel, and cycled backwards four times to reach it. T0110 made chase the
 * default, so the arrangement is inverted: the ship is focused and resolved from
 * frame one, and it is *leaving* the ship that has to be driven. The tier-ladder
 * coverage the old ordering gave (an unresolved, point-rendered ship at range)
 * is preserved by asserting it on the Sun-focused observatory view instead.
 */
async function runProductionPhase(browser) {
  const context = await browser.newContext({ viewport: { width: 1_280, height: 720 } });
  const page = await context.newPage();
  const browserErrors = collectBrowserErrors(page);
  await disableUnrelatedTrajectoryPrediction(page);

  try {
    const response = await page.goto(PRODUCTION_URL, { waitUntil: 'domcontentloaded' });
    assert.ok(response?.ok(), `production page returned ${String(response?.status())}`);
    await page.waitForSelector('#space-canvas[data-camera-ready="true"]', {
      state: 'attached',
      timeout: 60_000,
    });
    await page.waitForFunction(
      () =>
        (globalThis.document.querySelector('#space-canvas')?.solarVoyagerTelemetry
          ?.frameSampleCount ?? 0) > 0,
      undefined,
      { timeout: 60_000 },
    );

    const readShip = async () =>
      page.evaluate(() => {
        const canvas = globalThis.document.querySelector('#space-canvas');
        if (!(canvas instanceof globalThis.HTMLCanvasElement)) throw new Error('canvas missing');
        const ship = canvas.solarVoyagerShip;
        if (ship === undefined) throw new Error('ship diagnostics missing');
        return {
          diameterPx: ship.diameterPx,
          focused: ship.focused,
          focusLabel:
            globalThis.document.querySelector('#camera-focus-label')?.textContent ?? null,
          loadState: ship.loadState,
          modelOpacity: ship.modelOpacity,
          noseAlignment: ship.noseAlignment,
          noseNodeAlignment: ship.noseNodeAlignment,
          pointOpacity: ship.pointOpacity,
          resolved: ship.resolved,
          shipVisualCreations: canvas.solarVoyagerRuntimeResources?.shipVisualCreations ?? -1,
        };
      });

    const initial = await readShip();
    assert.equal(initial.shipVisualCreations, 1);
    // T0110 — third-person from the first frame.
    assert.equal(initial.focused, true, 'the shipped game did not open on the ship');
    assert.equal(initial.focusLabel, 'Focus: Ship');
    assert.equal(initial.resolved, true, 'the chased ship is not resolved');
    assertAligned(initial.noseAlignment, 'production initial attitude');

    // The model is fetched lazily *after* space-phase activation, never on the
    // startup critical path, so the first frames legitimately show the additive
    // point until the mesh arrives and cross-fades in.
    await page.waitForFunction(
      () =>
        globalThis.document.querySelector('#space-canvas')?.solarVoyagerShip?.modelOpacity === 1,
      undefined,
      { timeout: 60_000 },
    );

    const focused = await readShip();
    assert.equal(focused.focused, true);
    assert.equal(focused.loadState, 'ready');
    assert.equal(focused.resolved, true);
    assert.equal(focused.pointOpacity, 0);
    assert.equal(focused.focusLabel, 'Focus: Ship');
    assert.ok(
      focused.diameterPx > 60,
      `the chased ship is too small to see: ${String(focused.diameterPx)}`,
    );
    assertAligned(focused.noseAlignment, 'production focused composed');
    assertAligned(focused.noseNodeAlignment, 'production focused asset node');

    // Cycling forward must leave the ship and land back on a catalog body
    // without `Commands.setTarget` ever seeing the non-catalog id.
    await page.locator('#space-canvas').click({ position: { x: 8, y: 8 } });
    await page.keyboard.press(']');
    await page.waitForFunction(
      () =>
        globalThis.document.querySelector('#space-canvas')?.solarVoyagerShip?.focused === false,
      undefined,
      { timeout: 10_000 },
    );
    await waitForCameraMode(page, 'observatory');
    const afterCycle = await page.evaluate(
      () => globalThis.document.querySelector('#camera-focus-label')?.textContent ?? null,
    );
    assert.equal(afterCycle, 'Focus: Sun');

    // Tier ladder, from the other end: 1 AU away the 26 m hull is far below the
    // resolve threshold and falls back to its slot in the shared point cloud.
    // Waited for, not slept for: dropping back to the point sprite runs the same
    // hysteresis and cross-fade the resolve does.
    await page.waitForFunction(
      () =>
        globalThis.document.querySelector('#space-canvas')?.solarVoyagerShip?.modelOpacity === 0,
      undefined,
      { timeout: 60_000 },
    );
    const distant = await readShip();
    assert.equal(distant.resolved, false, 'the ship still resolves from a Sun-focused camera');
    assert.equal(distant.pointOpacity, 1);
    assert.equal(distant.modelOpacity, 0);
    assert.ok(
      distant.diameterPx > 0 && distant.diameterPx < 1.8,
      `unexpected distant ship angular size: ${String(distant.diameterPx)}`,
    );

    // ...and stepping the ring back onto the ship returns to the chase camera.
    for (let press = 0; press < FOCUS_CYCLE_BACKWARD_PRESSES; press += 1) {
      await page.keyboard.press('[');
    }
    await page.waitForFunction(
      () =>
        globalThis.document.querySelector('#space-canvas')?.solarVoyagerShip?.focused === true,
      undefined,
      { timeout: 10_000 },
    );
    await waitForCameraMode(page, 'chase');
    await page.waitForFunction(
      () =>
        globalThis.document.querySelector('#space-canvas')?.solarVoyagerShip?.modelOpacity === 1,
      undefined,
      { timeout: 60_000 },
    );
    const returned = await readShip();
    assert.equal(returned.focusLabel, 'Focus: Ship');
    assert.equal(returned.resolved, true);

    let capture = null;
    if (CAPTURE_PATH !== null) capture = await captureLeoProof(page, readShip);

    assert.deepEqual(browserErrors, []);
    return { afterCycle, capture, distant, focused, initial, returned };
  } finally {
    await context.close();
  }
}

/**
 * Opt-in third-person proof shot: the ship on its chase arm with a daylit Earth
 * behind it.
 *
 * The ship starts at local midnight, so half an orbit of time warp carries it to
 * Earth's daylit side. The composition is then the radial-in attitude hold: it
 * aims the nose at Earth, and because the chase arm hangs behind the nose the
 * camera ends up looking down the same line — ship centred, planet filling the
 * frame behind it. The hold turns at 15 deg/s of *simulated* time (ADR-035), so
 * a half turn costs 12 s of simulation; warp pays for that without costing
 * twelve seconds of wall clock.
 *
 * Not asserted in CI — it is evidence for the pull request.
 */
async function captureLeoProof(page, readShip) {
  const startSimTimeSec = await page.evaluate(
    () =>
      globalThis.document.querySelector('#space-canvas')?.solarVoyagerSystemMap
        ?.simulationTimeSec ?? 0,
  );
  for (let press = 0; press < WARP_RUNGS_FOR_CAPTURE; press += 1) {
    await page.keyboard.press('Equal');
  }
  await page.waitForFunction(
    (deadlineSec) =>
      (globalThis.document.querySelector('#space-canvas')?.solarVoyagerSystemMap
        ?.simulationTimeSec ?? 0) >= deadlineSec,
    startSimTimeSec + LEO_HALF_PERIOD_SEC,
    { timeout: 180_000 },
  );
  for (let press = 0; press < WARP_RUNGS_FOR_CAPTURE; press += 1) {
    await page.keyboard.press('Minus');
  }
  await page.waitForTimeout(1_500);
  // Prograde hold, slewed under moderate warp, then back to 1x to settle: the
  // nose runs along track, so the chase arm looks forward over a daylit Earth
  // rather than straight down into it.
  await page.keyboard.press('Digit2');
  for (let press = 0; press < 3; press += 1) await page.keyboard.press('Equal');
  await page.waitForTimeout(4_000);
  for (let press = 0; press < 3; press += 1) await page.keyboard.press('Minus');
  await page.waitForTimeout(1_500);
  // Swing the arm up and round: a three-quarter view with the limb below reads
  // better than dead astern, and it puts the Sun across the hull instead of
  // behind it.
  for (let press = 0; press < 3; press += 1) await page.keyboard.press('Shift+ArrowUp');
  for (let press = 0; press < 4; press += 1) await page.keyboard.press('Shift+ArrowLeft');
  await page.waitForTimeout(1_500);
  // `display: none` (not `visibility`) so the state-vector widget's viewport
  // collapses to zero and stops drawing its panel into the WebGL canvas.
  await page.evaluate(() => {
    const overlay = globalThis.document.querySelector('.app-overlay');
    if (overlay instanceof globalThis.HTMLElement) overlay.style.display = 'none';
    globalThis.dispatchEvent(new globalThis.Event('resize'));
  });
  await page.waitForTimeout(1_000);
  await mkdir(path.dirname(CAPTURE_PATH), { recursive: true });
  await page.screenshot({ path: CAPTURE_PATH });
  const state = {
    ...(await readShip()),
    camera: await page.evaluate(() => {
      const camera = globalThis.document.querySelector('#space-canvas')?.solarVoyagerCamera;
      return camera === undefined
        ? null
        : {
            armDistanceKm: camera.armDistanceKm,
            focusId: camera.focusId,
            mode: camera.mode,
            shipDistanceKm: camera.shipDistanceKm,
          };
    }),
  };
  await page.evaluate(() => {
    const overlay = globalThis.document.querySelector('.app-overlay');
    if (overlay instanceof globalThis.HTMLElement) overlay.style.display = '';
    globalThis.dispatchEvent(new globalThis.Event('resize'));
  });
  return { path: CAPTURE_PATH, state };
}

await assertPortAvailable(FIXTURE_PORT, HOST);
await assertPortAvailable(PRODUCTION_PORT, HOST);
const fixtureServer = await createServer({
  root: process.cwd(),
  base: '/solar-voyager/',
  logLevel: 'error',
  server: { host: HOST, port: FIXTURE_PORT, strictPort: true },
});
const productionServer = await preview({
  root: process.cwd(),
  base: '/solar-voyager/',
  logLevel: 'error',
  preview: { host: HOST, port: PRODUCTION_PORT, strictPort: true },
});
let browser;

try {
  await fixtureServer.listen();
  browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: [
      '--enable-unsafe-swiftshader',
      '--enable-webgl',
      '--ignore-gpu-blocklist',
      '--use-angle=swiftshader',
    ],
  });
  const fixture = await runFixturePhase(browser);
  const production = await runProductionPhase(browser);
  process.stdout.write(`${JSON.stringify({ fixture, production }, null, 2)}\n`);
} finally {
  if (browser !== undefined) await browser.close();
  await productionServer.close();
  await fixtureServer.close();
}
