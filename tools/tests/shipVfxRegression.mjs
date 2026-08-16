import assert from 'node:assert/strict';

import { chromium } from 'playwright';
import { createServer, preview } from 'vite';

import { assertPortAvailable } from '../bench/scaffoldBenchUtils.mjs';
import { installHighQualitySetting } from '../perf/browserSettings.mjs';
import { disableUnrelatedTrajectoryPrediction } from './trajectoryPredictionTestIsolation.mjs';
import { resolveHarnessPort } from '../harnessPort.mjs';

const HOST = '127.0.0.1';
const FIXTURE_PORT = resolveHarnessPort(4213);
const PRODUCTION_PORT = resolveHarnessPort(4214);
const FIXTURE_URL = `http://${HOST}:${String(FIXTURE_PORT)}/solar-voyager/tests/render/shipVfx.html`;
const PRODUCTION_URL = `http://${HOST}:${String(PRODUCTION_PORT)}/solar-voyager/?autostart=1`;

/** `?autostart=1` opens in LEO on the chase arm; the ship is roughly 90 px wide. */
const CLOSE_DIAMETER_PX = 90;
/** Beam objects: the lathe and the nozzle glow. Puffs are a third. */
const MAX_NEW_DRAW_CALLS = 3;
/** `R` is `throttleIncrease`, `W` is `pitchUp` (settings.ts defaults). */
const THROTTLE_KEY = 'r';
const PITCH_KEY = 'w';

function collectBrowserErrors(page) {
  const errors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('crash', () => errors.push('page crash'));
  return errors;
}

/**
 * Fixture phase: the plume, the puffs, the lights and the far-field magnitude
 * against the real `ship.glb`, with pixel readback and draw-call counters.
 */
async function runFixturePhase(browser) {
  const page = await browser.newPage({ viewport: { width: 256, height: 256 } });
  const browserErrors = collectBrowserErrors(page);
  try {
    await page.goto(FIXTURE_URL, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => globalThis.__shipVfxHarness !== undefined, undefined, {
      timeout: 60_000,
    });
    await page.evaluate(async () => {
      await globalThis.__shipVfxHarness.awaitModel();
    });
    assert.equal(
      await page.evaluate(() => globalThis.__shipVfxHarness.loadState()),
      'ready',
      'the ship model never resolved in the VFX fixture',
    );

    const step = async (overrides) =>
      page.evaluate(
        (options) => globalThis.__shipVfxHarness.step(options),
        {
          distanceKm: 0,
          throttle: 0,
          bodyRateRadS: [0, 0, 0],
          simTimeSec: 0,
          simDeltaSec: 1 / 60,
          nowMs: 0,
          ...overrides,
        },
      );
    const closeDistanceKm = await page.evaluate(
      (diameterPx) => {
        const size = 256;
        const fov = Math.PI / 3;
        const radiusKm = 0.013_06;
        return radiusKm / Math.sin(((diameterPx * fov) / size) * 0.5);
      },
      CLOSE_DIAMETER_PX,
    );

    // Settle the model in frame before anything is measured: the cross-fade is
    // time-driven and would otherwise contaminate the coasting baseline.
    await step({ distanceKm: closeDistanceKm, nowMs: 0 });
    const coasting = await step({ distanceKm: closeDistanceKm, nowMs: 600 });
    assert.equal(coasting.glError, 0, `coasting: WebGL error ${String(coasting.glError)}`);
    assert.equal(coasting.burning, false, 'a coasting ship is burning');
    assert.equal(coasting.beamLengthM, 0, 'a coasting ship has a beam');
    assert.equal(coasting.rcsFiring, false, 'a coasting ship is puffing');
    assert.equal(coasting.modelBound, true, 'the effects never adopted the loaded model');
    assert.equal(
      coasting.anchorsVerified,
      true,
      `transcribed anchors disagree with ship.glb by ${String(coasting.anchorErrorM)} m`,
    );
    assert.equal(coasting.lightCount, 3, `expected 3 light materials, got ${String(coasting.lightCount)}`);

    const programsBeforeBurn = await page.evaluate(() =>
      globalThis.__shipVfxHarness.programCount(),
    );
    const burning = await step({ distanceKm: closeDistanceKm, throttle: 1, nowMs: 700 });
    assert.equal(burning.glError, 0, `burning: WebGL error ${String(burning.glError)}`);
    assert.equal(burning.burning, true, 'full throttle did not light the beam');
    // 4 ship lengths of 26.12 m.
    assert.ok(
      Math.abs(burning.beamLengthM - 104.48) < 1e-6,
      `full-throttle beam is ${String(burning.beamLengthM)} m, expected 104.48`,
    );
    assert.ok(
      burning.litPixels > coasting.litPixels * 1.2,
      `the beam did not brighten the frame: ${JSON.stringify({ coasting: coasting.litPixels, burning: burning.litPixels })}`,
    );
    const burnDrawCalls = burning.drawCalls - coasting.drawCalls;
    assert.equal(burnDrawCalls, 2, `beam + glow cost ${String(burnDrawCalls)} draw calls, expected 2`);

    // One frame is one response: a throttle cut must be gone immediately.
    const cut = await step({ distanceKm: closeDistanceKm, throttle: 0, nowMs: 720 });
    assert.equal(cut.burning, false, 'the beam survived a throttle cut');
    assert.equal(cut.drawCalls, coasting.drawCalls, 'a cut beam still costs draw calls');

    const partial = await step({ distanceKm: closeDistanceKm, throttle: 0.25, nowMs: 740 });
    assert.ok(
      partial.beamLengthM < burning.beamLengthM && partial.beamLengthM > burning.beamLengthM * 0.3,
      `quarter throttle should follow the ^0.7 curve, got ${String(partial.beamLengthM)} m`,
    );

    // RCS: a yaw command, differentiated from the attitude by the production rule.
    await step({ distanceKm: closeDistanceKm, bodyRateRadS: [0, 0.2, 0], nowMs: 760 });
    const yawing = await step({ distanceKm: closeDistanceKm, bodyRateRadS: [0, 0.2, 0], nowMs: 780 });
    assert.equal(yawing.glError, 0, `yawing: WebGL error ${String(yawing.glError)}`);
    assert.equal(yawing.rcsFiring, true, 'a yaw command fired no RCS puffs');
    assert.equal(yawing.rcsLivePuffCount, 4, `yaw lit ${String(yawing.rcsLivePuffCount)} bells, expected 4`);
    assert.equal(
      yawing.drawCalls - coasting.drawCalls,
      1,
      'the sixteen-bell puff pool is not a single draw call',
    );
    const rolling = await step({ distanceKm: closeDistanceKm, bodyRateRadS: [0, 0, 0.2], nowMs: 800 });
    assert.equal(rolling.rcsLivePuffCount, 4, 'a roll command lit the wrong number of bells');

    const everything = await step({
      distanceKm: closeDistanceKm,
      throttle: 1,
      bodyRateRadS: [0.2, 0.2, 0.2],
      nowMs: 820,
    });
    const worstCaseDrawCalls = everything.drawCalls - coasting.drawCalls;
    assert.ok(
      worstCaseDrawCalls <= MAX_NEW_DRAW_CALLS,
      `worst case costs ${String(worstCaseDrawCalls)} draw calls, budget ${String(MAX_NEW_DRAW_CALLS)}`,
    );
    assert.ok(
      everything.rcsLivePuffCount <= 16,
      `the pool exceeded its cap: ${String(everything.rcsLivePuffCount)}`,
    );

    // The whole point of the warm-up: burning for the first time compiles nothing.
    const programsAfterBurn = await page.evaluate(() =>
      globalThis.__shipVfxHarness.programCount(),
    );
    assert.equal(
      programsAfterBurn,
      programsBeforeBurn,
      `the first burn compiled ${String(programsAfterBurn - programsBeforeBurn)} shader program(s)`,
    );

    // Lights are sim-time driven, so a frozen clock freezes the strobe.
    const darkBeacon = await step({ distanceKm: closeDistanceKm, simTimeSec: 0.8, nowMs: 840 });
    const heldBeacon = await step({ distanceKm: closeDistanceKm, simTimeSec: 0.8, nowMs: 860 });
    const litBeacon = await step({ distanceKm: closeDistanceKm, simTimeSec: 0.22, nowMs: 880 });
    assert.equal(darkBeacon.beaconFactor, heldBeacon.beaconFactor, 'a frozen sim clock moved the beacon');
    assert.ok(
      litBeacon.beaconFactor > darkBeacon.beaconFactor * 4,
      `the beacon does not flash: ${String(darkBeacon.beaconFactor)} -> ${String(litBeacon.beaconFactor)}`,
    );

    // Governor: the lowest rung coarsens the beam and empties the puff pool.
    await page.evaluate(() => {
      globalThis.__shipVfxHarness.applyRung(14);
    });
    const governed = await step({
      distanceKm: closeDistanceKm,
      throttle: 1,
      bodyRateRadS: [0, 0.2, 0],
      nowMs: 900,
    });
    assert.equal(governed.beamSegments, 6, `governed beam has ${String(governed.beamSegments)} segments`);
    assert.equal(governed.rcsLiveCapacity, 0, 'the lowest rung kept the puff pool alive');
    assert.equal(governed.rcsFiring, false, 'the lowest rung still drew puffs');
    assert.ok(
      governed.triangles < everything.triangles,
      `the governed beam is not cheaper: ${String(governed.triangles)} vs ${String(everything.triangles)}`,
    );
    await page.evaluate(() => {
      globalThis.__shipVfxHarness.applyRung(0);
    });
    const restored = await step({ distanceKm: closeDistanceKm, throttle: 1, nowMs: 920 });
    assert.equal(restored.beamSegments, 24, 'the beam did not come back at rung 0');

    // Far field: the artificial star, through the shared magnitude path.
    const oneAu = await page.evaluate(
      ([distanceKm, throttle]) => globalThis.__shipVfxHarness.farField(distanceKm, throttle),
      [149_597_870.7, 1],
    );
    assert.ok(
      oneAu.reflectedOnly > 20,
      `a coasting hull at 1 AU should be invisible, got magnitude ${String(oneAu.reflectedOnly)}`,
    );
    assert.ok(
      oneAu.reflectedOnly - oneAu.withPlume > 12,
      `the plume did not brighten the far-field point: ${JSON.stringify(oneAu)}`,
    );
    assert.ok(
      oneAu.withPlume < 8,
      `a full burn at 1 AU is magnitude ${String(oneAu.withPlume)}, expected naked-eye scale`,
    );

    const final = await step({ distanceKm: closeDistanceKm, nowMs: 940 });
    assert.equal(final.nonFiniteObserved, false, 'an effect binding degraded during the fixture run');
    assert.equal(final.degradedBindingCount, 0, 'an effect binding is degraded');
    assert.equal(final.skippedBindCount, 0, 'the guard skipped a bind');

    assert.deepEqual(browserErrors, []);
    return { burning, coasting, everything, governed, oneAu, yawing };
  } finally {
    await page.close();
  }
}

/**
 * Production phase: the shipped game burns, puffs and blinks, and the burn costs
 * no shader compile and no more than three draw calls.
 */
async function runProductionPhase(browser) {
  const context = await browser.newContext({ viewport: { width: 1_280, height: 720 } });
  const page = await context.newPage();
  const browserErrors = collectBrowserErrors(page);
  // The governor is doing its job on a software rasterizer: auto quality drops
  // to a rung where the puff pool is empty and the beam is quarter-tessellated.
  // The high-quality lock is what lets this gate assert the *shipped* rung, the
  // way the perf gate does; the governor's own ladder is covered by the fixture
  // phase and by `perfGovernor.test.ts`.
  await installHighQualitySetting(page);
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
        globalThis.document.querySelector('#space-canvas')?.solarVoyagerShip?.modelOpacity === 1,
      undefined,
      { timeout: 60_000 },
    );

    const readEffects = async () =>
      page.evaluate(() => {
        const canvas = globalThis.document.querySelector('#space-canvas');
        if (!(canvas instanceof globalThis.HTMLCanvasElement)) throw new Error('canvas missing');
        const effects = canvas.solarVoyagerShipEffects;
        if (effects === undefined) throw new Error('ship effects diagnostics missing');
        return {
          anchorErrorM: effects.anchorErrorM,
          anchorsVerified: effects.anchorsVerified,
          beaconFactor: effects.beaconFactor,
          beamLengthM: effects.beamLengthM,
          beamSegments: effects.beamSegments,
          burning: effects.burning,
          degradedBindingCount: effects.degradedBindingCount,
          drawCalls: canvas.solarVoyagerTelemetry?.snapshot.drawCalls ?? -1,
          lightCount: effects.lightCount,
          modelBound: effects.modelBound,
          nonFiniteObserved: effects.nonFiniteObserved,
          plumeMagnitude: effects.plumeMagnitude,
          programCount: canvas.solarVoyagerStartup?.programCountCurrent ?? -1,
          rcsFiring: effects.rcsFiring,
          rcsLiveCapacity: effects.rcsLiveCapacity,
          simTimeSec: canvas.solarVoyagerSystemMap?.simulationTimeSec ?? -1,
          skippedBindCount: effects.skippedBindCount,
          throttle: effects.throttle,
        };
      });

    const idle = await readEffects();
    assert.equal(idle.modelBound, true, 'the shipped game never bound the ship model to its effects');
    assert.equal(
      idle.anchorsVerified,
      true,
      `shipped anchors disagree with ship.glb by ${String(idle.anchorErrorM)} m`,
    );
    assert.equal(idle.lightCount, 3, `expected 3 running lights, got ${String(idle.lightCount)}`);
    assert.equal(idle.burning, false, 'the game opened with the drive lit');
    assert.equal(idle.rcsLiveCapacity, 16, `puff pool opened at ${String(idle.rcsLiveCapacity)}`);

    await page.locator('#space-canvas').click({ position: { x: 8, y: 8 } });
    // The click is its own baseline. Focusing the canvas runs the click-to-target
    // path (T0117) and lets the trajectory predictor publish, both of which can
    // compile programs that have nothing to do with the drive; measuring the VFX
    // deltas from here attributes a compile to the effect that caused it instead
    // of to whichever interaction happened to come first.
    await page.waitForTimeout(1_500);
    const focused = await readEffects();

    // Puffs first, then the burn, so a first-use shader compile is attributed to
    // the effect that caused it instead of to whichever ran first.
    await page.keyboard.down(PITCH_KEY);
    await page.waitForFunction(
      () =>
        globalThis.document.querySelector('#space-canvas')?.solarVoyagerShipEffects?.rcsFiring ===
        true,
      undefined,
      { timeout: 15_000 },
    );
    const puffing = await readEffects();
    await page.keyboard.up(PITCH_KEY);
    assert.equal(puffing.rcsFiring, true, 'a manual pitch fired no puffs');
    assert.equal(
      puffing.programCount,
      focused.programCount,
      `the first puff compiled ${String(puffing.programCount - focused.programCount)} shader program(s)`,
    );
    const puffingDelta = puffing.drawCalls - focused.drawCalls;
    assert.ok(
      puffingDelta >= 0 && puffingDelta <= MAX_NEW_DRAW_CALLS,
      `puffing moved draw calls by ${String(puffingDelta)}`,
    );

    for (let press = 0; press < 12; press += 1) await page.keyboard.press(THROTTLE_KEY);
    await page.waitForFunction(
      () =>
        (globalThis.document.querySelector('#space-canvas')?.solarVoyagerShipEffects?.throttle ??
          0) > 0,
      undefined,
      { timeout: 15_000 },
    );
    const burning = await readEffects();
    assert.equal(burning.burning, true, 'the throttle did not light the beam in the shipped game');
    assert.ok(burning.beamLengthM > 0, 'a lit beam has zero length');
    assert.ok(
      Number.isFinite(burning.plumeMagnitude),
      'a burning ship has no far-field plume magnitude',
    );
    assert.equal(
      burning.programCount,
      puffing.programCount,
      `the first burn compiled ${String(burning.programCount - puffing.programCount)} shader program(s)`,
    );
    const drawCallDelta = burning.drawCalls - focused.drawCalls;
    assert.ok(
      drawCallDelta >= 0 && drawCallDelta <= MAX_NEW_DRAW_CALLS,
      `burning moved draw calls by ${String(drawCallDelta)}, budget ${String(MAX_NEW_DRAW_CALLS)}`,
    );

    // The beacon is driven by SIMULATION time, which is what makes pause freeze
    // it (T0112). Sampling for a flash would be a lottery on a software
    // rasterizer — a 90 ms pulse in a 1.6 s period, watched at a handful of
    // frames per second — so the deterministic waveform is asserted in the
    // fixture phase and this phase asserts the property that actually matters:
    // a frozen simulation clock freezes the light.
    const running = [await readEffects(), null];
    await page.waitForTimeout(400);
    running[1] = await readEffects();
    assert.ok(
      (running[1]?.simTimeSec ?? 0) > (running[0]?.simTimeSec ?? 0),
      'the simulation clock did not advance while running',
    );
    for (const sample of running) {
      assert.ok(
        Number.isFinite(sample?.beaconFactor) &&
          (sample?.beaconFactor ?? -1) >= 0.25 &&
          (sample?.beaconFactor ?? -1) <= 6,
        `beacon factor outside its published band: ${String(sample?.beaconFactor)}`,
      );
    }

    await page.keyboard.press('Escape');
    await page.waitForSelector('#pause-menu', { state: 'visible', timeout: 10_000 });
    const pausedFirst = await readEffects();
    await page.waitForTimeout(500);
    const pausedSecond = await readEffects();
    assert.equal(
      pausedSecond.simTimeSec,
      pausedFirst.simTimeSec,
      'the simulation clock advanced while paused',
    );
    assert.equal(
      pausedSecond.beaconFactor,
      pausedFirst.beaconFactor,
      'pause did not freeze the anti-collision beacon',
    );
    assert.equal(
      pausedSecond.navFactor,
      pausedFirst.navFactor,
      'pause did not freeze the navigation lights',
    );
    await page.keyboard.press('Escape');

    const final = await readEffects();
    assert.equal(final.nonFiniteObserved, false, 'an effect binding degraded in the shipped game');
    assert.equal(final.degradedBindingCount, 0, 'an effect binding is degraded');
    assert.equal(final.skippedBindCount, 0, 'the guard skipped a bind in the shipped game');

    assert.deepEqual(browserErrors, []);
    return { burning, drawCallDelta, focused, idle, paused: pausedSecond, puffing };
  } finally {
    await context.close();
  }
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
