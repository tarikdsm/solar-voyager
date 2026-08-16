import assert from 'node:assert/strict';
import path from 'node:path';

import { chromium } from 'playwright';
import { preview } from 'vite';

import { assertPortAvailable } from '../bench/scaffoldBenchUtils.mjs';
import { disableUnrelatedTrajectoryPrediction } from './trajectoryPredictionTestIsolation.mjs';
import { resolveHarnessPort } from '../harnessPort.mjs';

/**
 * T0112 browser regression: HUD presets, the real pause, and world markers.
 *
 * Runs against the production build with a *default* profile, because the
 * default is the thing under test: v2 boots into Clean, and the panels v1 always
 * showed must genuinely not be in the document.
 */

const HOST = '127.0.0.1';
const PORT = resolveHarnessPort(4207);
const PAGE_URL = `http://${HOST}:${String(PORT)}/solar-voyager/?autostart=1`;
const SETTINGS_STORAGE_KEY = 'solar-voyager.settings.v5';
const SCREENSHOT_DIRECTORY = path.resolve('docs/bench');

/** Engineer-only panels: present exactly when the preset says so. */
const ENGINEER_SELECTORS = Object.freeze([
  '#orbit-readout',
  '#dual-clock',
  '#warp-control',
  '#energy-panel',
  '#target-panel',
  '#burn-log-toggle',
  '.state-vector-panel',
]);

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
 * Acknowledges the software-rendering warning, if it is up.
 *
 * CI always raises it, it deliberately sits *above* the pause layers (it is a
 * mandatory alert), and it comes back on every navigation because the
 * acknowledgement is component state rather than a preference. Called after each
 * load so this gate measures the HUD and not the banner — and so the committed
 * Clean-preset screenshot is free of an environment artifact.
 */
async function dismissHardwareWarning(page) {
  const warning = page.locator('#hardware-acceleration-warning');
  if (!(await warning.isVisible())) return;
  await warning.getByRole('button', { name: 'I understand' }).click();
  await warning.waitFor({ state: 'detached', timeout: 10_000 });
}

function logPhase(phase) {
  process.stdout.write(`[hud-presets] ${phase}\n`);
}

async function readHudState(page) {
  return page.evaluate((engineerSelectors) => {
    const canvas = globalThis.document.querySelector('#space-canvas');
    const overlay = globalThis.document.querySelector('.app-overlay');
    const counts = {};
    for (const selector of engineerSelectors) {
      counts[selector] = globalThis.document.querySelectorAll(selector).length;
    }
    return {
      counts,
      preset: overlay?.getAttribute('data-hud-preset') ?? null,
      paused: overlay?.getAttribute('data-paused') ?? null,
      sceneState: canvas?.dataset.sceneState ?? null,
      indicator:
        globalThis.document.querySelector('#hud-preset-indicator strong')?.textContent ?? null,
      flightStrip: globalThis.document.querySelectorAll('#flight-strip').length,
      reticleHidden: globalThis.document.querySelector('#hud-reticle')?.hidden ?? null,
      navball: globalThis.document.querySelectorAll('.navball').length,
      simTimeSec: canvas?.solarVoyagerSystemMap?.simulationTimeSec ?? null,
      storedPreset: (() => {
        const raw = globalThis.localStorage.getItem('solar-voyager.settings.v5');
        if (raw === null) return null;
        try {
          return JSON.parse(raw).hud.preset;
        } catch {
          return 'unparseable';
        }
      })(),
    };
  }, ENGINEER_SELECTORS);
}

function assertEngineerPanelsAbsent(state, phase) {
  for (const selector of ENGINEER_SELECTORS) {
    assert.equal(state.counts[selector], 0, `${selector} was still mounted in ${phase}`);
  }
}

await assertPortAvailable(PORT, HOST);
const server = await preview({
  root: process.cwd(),
  base: '/solar-voyager/',
  logLevel: 'error',
  preview: { host: HOST, port: PORT, strictPort: true },
});
let browser;

try {
  browser = await chromium.launch({
    headless: true,
    args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 1_280, height: 720 } });
  const errors = collectBrowserErrors(page);
  await disableUnrelatedTrajectoryPrediction(page);
  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#flight-strip', { state: 'visible', timeout: 60_000 });
  await page.waitForFunction(
    () =>
      globalThis.document.querySelector('#space-canvas')?.dataset.cameraReady === 'true',
    undefined,
    { timeout: 60_000 },
  );
  await dismissHardwareWarning(page);
  logPhase('space phase ready');

  // ---------------------------------------------------------------- Clean
  const clean = await readHudState(page);
  assert.equal(clean.preset, 'clean', 'a default profile did not boot into the Clean preset');
  assert.equal(clean.sceneState, 'space');
  assert.equal(clean.flightStrip, 1, 'the throttle/speed strip is missing from Clean');
  assert.equal(clean.reticleHidden, false, 'the reticle is missing from Clean');
  assert.equal(clean.navball, 0, 'the navball is a Pilot surface and must not be in Clean');
  assertEngineerPanelsAbsent(clean, 'Clean');
  assert.equal(clean.indicator, 'Clean');
  // Clean is a real HUD, not an empty one: it must still say how fast you are going.
  assert.match(
    (await page.locator('#flight-strip-speed-value').textContent()) ?? '',
    /^[\d.,]+ (?:m\/s|km\/s|%c)$/u,
    'the Clean speed strip is not showing a context-unit speed',
  );
  assert.match((await page.locator('#flight-strip-throttle-value').textContent()) ?? '', /^\d+%$/u);
  assert.equal(await page.locator('#cruise-status-phase').textContent(), 'Standby');
  logPhase('Clean preset verified');

  await page.screenshot({
    path: path.join(SCREENSHOT_DIRECTORY, 'T0112-clean-preset.png'),
  });
  logPhase('Clean preset screenshot captured');

  // ---------------------------------------------------------------- cycle
  await page.keyboard.press('KeyH');
  await page.waitForSelector('.navball', { state: 'visible', timeout: 10_000 });
  const pilot = await readHudState(page);
  assert.equal(pilot.preset, 'pilot');
  assert.equal(pilot.indicator, 'Pilot');
  assert.equal(pilot.navball, 1, 'Pilot did not add the navball');
  assert.equal(
    pilot.counts['#warp-control'],
    1,
    'Pilot did not add the warp indicator',
  );
  assert.equal(pilot.counts['#orbit-readout'], 0, 'Pilot leaked an Engineer panel');
  assert.equal(pilot.storedPreset, 'pilot', 'the preset did not persist to the profile');

  await page.keyboard.press('KeyH');
  await page.waitForSelector('#orbit-readout', { state: 'visible', timeout: 10_000 });
  const engineer = await readHudState(page);
  assert.equal(engineer.preset, 'engineer');
  for (const selector of ENGINEER_SELECTORS) {
    assert.equal(engineer.counts[selector], 1, `${selector} is missing from Engineer`);
  }
  assert.equal(engineer.storedPreset, 'engineer');

  await page.keyboard.press('KeyH');
  await page.waitForSelector('#orbit-readout', { state: 'detached', timeout: 10_000 });
  assert.equal((await readHudState(page)).preset, 'clean', 'the ring did not wrap');
  logPhase('preset ring verified and persisted');

  // The choice survives a reload: it is profile state, not session state.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#flight-strip', { state: 'visible', timeout: 60_000 });
  await dismissHardwareWarning(page);
  await page.keyboard.press('KeyH');
  await page.keyboard.press('KeyH');
  await page.waitForSelector('#orbit-readout', { state: 'visible', timeout: 10_000 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#orbit-readout', { state: 'visible', timeout: 60_000 });
  await dismissHardwareWarning(page);
  assert.equal(
    await page.evaluate(
      (key) => JSON.parse(globalThis.localStorage.getItem(key) ?? '{}').hud?.preset ?? null,
      SETTINGS_STORAGE_KEY,
    ),
    'engineer',
  );
  logPhase('preset survives a reload');

  // ---------------------------------------------------------------- world markers
  await page.selectOption('#target-selector', 'moon');
  await page.waitForFunction(
    () => globalThis.document.querySelector('#world-marker-target')?.hidden === false,
    undefined,
    { timeout: 15_000 },
  );
  const marker = await page.evaluate(() => {
    const element = globalThis.document.querySelector('#world-marker-target');
    const distance = element?.querySelector('.world-marker-distance')?.textContent ?? '';
    const rect = element?.getBoundingClientRect();
    return {
      distance,
      state: element?.getAttribute('data-state') ?? null,
      x: rect?.left ?? -1,
      y: rect?.top ?? -1,
      labels: globalThis.document.querySelectorAll('.world-body-label:not([hidden])').length,
    };
  });
  assert.match(marker.distance, /km$/u, `target marker distance is unreadable: ${marker.distance}`);
  // On screen or pinned to the edge, but always somewhere the player can see it:
  // the diamond is the only in-world cue for where the target is.
  assert.ok(
    marker.x >= -40 && marker.x <= 1_320 && marker.y >= -40 && marker.y <= 760,
    `target marker is outside the viewport: ${JSON.stringify(marker)}`,
  );
  assert.ok(
    ['onscreen', 'offscreen', 'behind'].includes(marker.state),
    `target marker has no bearing state: ${JSON.stringify(marker)}`,
  );
  assert.ok(marker.labels > 0, 'body labels are enabled by default but none are drawn');

  /*
   * Blur first: whether a HUD key is suppressed while a form control owns the
   * keyboard is `blocksGameKey`'s contract and is unit-tested in
   * `src/game/input/inputEngine.test.ts`. Asserting it here would also mean
   * pressing a letter into a focused `<select>`, whose type-ahead would silently
   * change the navigation target out from under the next phase.
   */
  await page.evaluate(() => {
    const active = globalThis.document.activeElement;
    if (active instanceof globalThis.HTMLElement) active.blur();
  });
  await page.keyboard.press('KeyL');
  await page.waitForFunction(
    () => globalThis.document.querySelectorAll('.world-body-label:not([hidden])').length === 0,
    undefined,
    { timeout: 10_000 },
  );
  assert.equal(
    await page.evaluate(
      (key) => JSON.parse(globalThis.localStorage.getItem(key) ?? '{}').hud?.bodyLabels ?? null,
      SETTINGS_STORAGE_KEY,
    ),
    false,
  );
  await page.keyboard.press('KeyL');
  logPhase('world markers verified');

  // ---------------------------------------------------------------- click-to-target
  /*
   * Aim the observatory camera at Earth first, which puts Earth's disc exactly at
   * the viewport centre — the one screen position this harness can predict
   * without reimplementing the projection it is supposed to be testing. The
   * navigation target is Mars at this point, so a successful pick has to *change*
   * it, which is what proves the click reached `Commands.setTarget` rather than
   * merely hitting something.
   */
  await page.selectOption('#target-selector', 'mars');
  await page.evaluate(() => {
    const active = globalThis.document.activeElement;
    if (active instanceof globalThis.HTMLElement) active.blur();
  });
  await page.keyboard.press('e');
  await page.waitForFunction(
    () => globalThis.document.querySelector('#camera-focus-label')?.textContent === 'Focus: Earth',
    undefined,
    { timeout: 15_000 },
  );
  // Wait on the camera's own diagnostic, not a sleep: the focus label is written
  // from the keydown handler while the pose is still 1.5 s of cross-fade away
  // from the body it names, and a click during the blend legitimately hits empty
  // sky.
  await page.waitForFunction(
    () =>
      globalThis.document.querySelector('#space-canvas')?.solarVoyagerCamera?.transitioning ===
      false,
    undefined,
    { timeout: 15_000 },
  );

  // Real mouse input, not synthetic `PointerEvent`s: `CameraInputController`
  // calls `setPointerCapture` on the same gesture, which throws for a pointer id
  // the browser never issued — and a harness that has to ignore the errors it
  // causes is not exercising the real path.
  const canvasBox = await page.locator('#space-canvas').boundingBox();
  assert.ok(canvasBox !== null, 'the canvas has no layout box');
  /*
   * Ask the page for a point that actually lands on the canvas rather than
   * hard-coding the viewport centre: Earth fills the whole frame from a 400 km
   * orbit, so any uncovered pixel works, and the HUD cluster that occupies the
   * middle of the screen is a legitimate layout choice this gate must not pin.
   */
  const point = await page.evaluate(
    ({ x, y, width, height }) => {
      for (const fraction of [0.3, 0.22, 0.38, 0.5, 0.62]) {
        const px = x + width / 2;
        const py = y + height * fraction;
        if (globalThis.document.elementFromPoint(px, py)?.id === 'space-canvas') {
          return { x: px, y: py };
        }
      }
      return null;
    },
    canvasBox,
  );
  assert.ok(point !== null, 'the HUD covers every candidate pick point');
  const centreX = point.x;
  const centreY = point.y;
  await page.mouse.click(centreX, centreY);
  await page.waitForTimeout(150);
  const picked = await page.evaluate(
    () => globalThis.document.querySelector('#space-canvas')?.dataset.pickedBodyId ?? null,
  );
  assert.equal(picked, 'earth', `clicking the centred disc did not pick Earth: ${picked}`);
  assert.equal(
    await page.locator('#target-selector').inputValue(),
    'earth',
    'the pick did not reach Commands.setTarget',
  );

  // A drag must not re-target: releasing over a body after orbiting the camera is
  // the gesture `CameraInputController` owns.
  await page.evaluate(() => {
    const canvas = globalThis.document.querySelector('#space-canvas');
    if (canvas instanceof globalThis.HTMLCanvasElement) canvas.dataset.pickedBodyId = 'sentinel';
  });
  await page.mouse.move(centreX - 90, centreY);
  await page.mouse.down();
  await page.mouse.move(centreX - 45, centreY, { steps: 4 });
  await page.mouse.move(centreX, centreY, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(150);
  const afterDrag = await page.evaluate(
    () => globalThis.document.querySelector('#space-canvas')?.dataset.pickedBodyId ?? null,
  );
  assert.equal(afterDrag, 'sentinel', 'releasing a drag over a body re-targeted it');
  logPhase('click-to-target verified, drag suppressed');

  // ---------------------------------------------------------------- pause
  const beforePause = await readHudState(page);
  await page.keyboard.press('Escape');
  await page.waitForSelector('#pause-menu', { state: 'visible', timeout: 10_000 });
  const paused = await readHudState(page);
  assert.equal(paused.sceneState, 'paused');
  assert.equal(paused.paused, 'true');
  await page
    .waitForFunction(
      () => globalThis.document.activeElement?.id === 'pause-resume',
      undefined,
      { timeout: 5_000 },
    )
    .catch(() => {
      throw new Error('the pause dialog did not take focus');
    });

  /*
   * The load-bearing assertion of the whole feature: simulation time must not
   * advance while the menu is up, *and* the animation loop must keep running.
   * Both halves matter — a pause that stops rAF lets the whole paused duration
   * arrive as one wall delta on resume, which at high warp is years of flight in
   * a single frame.
   */
  const frameCountAtPause = await page.evaluate(
    () => globalThis.document.querySelector('#space-canvas')?.solarVoyagerTelemetry?.snapshot
      .frameCount ?? -1,
  );
  await page.waitForTimeout(1_200);
  const stillPaused = await page.evaluate(() => {
    const canvas = globalThis.document.querySelector('#space-canvas');
    return {
      frameCount: canvas?.solarVoyagerTelemetry?.snapshot.frameCount ?? -1,
      simTimeSec: canvas?.solarVoyagerSystemMap?.simulationTimeSec ?? null,
    };
  });
  assert.equal(
    stillPaused.simTimeSec,
    paused.simTimeSec,
    'simulation time advanced while paused',
  );
  assert.ok(
    stillPaused.frameCount > frameCountAtPause,
    'the animation loop stopped while paused; frames must keep rendering',
  );
  assert.ok(
    paused.simTimeSec >= beforePause.simTimeSec,
    'simulation time went backwards on pause',
  );
  logPhase('simulation halted, frame loop alive');

  /*
   * Settings is one of the four named pause actions, and the z-ladder that puts
   * the panel above the backdrop is exactly the kind of thing that can be
   * reasoned about correctly and still be wrong: `.hud-grid` is a stacking
   * context, so a descendant's z-index cannot escape it. Clicking is the only
   * assertion that catches that, so the gate clicks.
   */
  await page.locator('#pause-settings').click();
  await page.waitForFunction(
    () => globalThis.document.querySelector('#session-settings')?.hasAttribute('open') === true,
    undefined,
    { timeout: 5_000 },
  );
  const settingsHit = await page.evaluate(() => {
    const summary = globalThis.document.querySelector('#session-settings > summary');
    if (summary === null) return { hit: null, inPanel: false };
    const rect = summary.getBoundingClientRect();
    const hit = globalThis.document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    );
    return {
      hit: hit === null ? null : `${hit.tagName}#${hit.id}`,
      inPanel: hit !== null && globalThis.document.querySelector('#session-settings').contains(hit),
    };
  });
  assert.ok(
    settingsHit.inPanel,
    `the paused settings panel is buried under the backdrop: ${JSON.stringify(settingsHit)}`,
  );
  // Actionability, not just hit-testing: Playwright refuses to click an
  // intercepted element, so these two are the real proof.
  await page.locator('#session-settings > summary').click({ timeout: 5_000 });
  await page.locator('#session-settings > summary').click({ timeout: 5_000 });
  await page.locator('#quality-lock').click({ timeout: 5_000 });
  // Leave the panel as it was found: a native select keeps focus, and a focused
  // form control legitimately blocks every game key (`blocksGameKey`), which
  // would make the later map and camera checks measure the wrong thing.
  await page.evaluate(() => {
    const active = globalThis.document.activeElement;
    if (active instanceof globalThis.HTMLElement) active.blur();
    const details = globalThis.document.querySelector('#session-settings');
    if (details instanceof globalThis.HTMLDetailsElement) details.open = false;
  });
  logPhase('paused settings panel is visible and clickable');

  /*
   * `aria-modal="true"` is a claim about the rest of the document; `inert` on the
   * HUD layer is what makes it true. Without it Tab walks out of the dialog into
   * the tutorial overlay and the state-vector controls.
   */
  const modalBacking = await page.evaluate(() => {
    const layer = globalThis.document.querySelector('.hud-layer');
    return {
      ariaModal: globalThis.document.querySelector('#pause-menu')?.getAttribute('aria-modal'),
      hudInert: layer === null ? null : layer.inert,
      reachable: globalThis.document
        .querySelector('#orbit-readout')
        ?.checkVisibility?.({ checkVisibilityCSS: true }),
    };
  });
  assert.equal(modalBacking.ariaModal, 'true');
  assert.equal(modalBacking.hudInert, true, 'aria-modal is not backed by an inert HUD');

  await page.locator('#pause-exit').focus();
  await page.keyboard.press('Tab');
  const forwardTab = await page.evaluate(() => {
    const active = globalThis.document.activeElement;
    return {
      id: active?.id ?? null,
      inPauseLayer: globalThis.document.querySelector('.pause-layer')?.contains(active) ?? false,
    };
  });
  assert.ok(
    forwardTab.inPauseLayer,
    `Tab escaped the pause layer to ${JSON.stringify(forwardTab)}`,
  );
  await page.locator('#pause-resume').focus();
  await page.keyboard.press('Shift+Tab');
  const backwardTab = await page.evaluate(() => {
    const active = globalThis.document.activeElement;
    return {
      id: active?.id ?? null,
      inPauseLayer: globalThis.document.querySelector('.pause-layer')?.contains(active) ?? false,
    };
  });
  assert.ok(
    backwardTab.inPauseLayer,
    `Shift+Tab escaped the pause layer to ${JSON.stringify(backwardTab)}`,
  );
  logPhase('modal claim backed and focus trapped in both directions');

  /*
   * The keyboard the frame loop does not own. `SystemMapPanel` and
   * `CameraInputController` hold their own window listeners, so without an
   * explicit gate `M` opened the map underneath the backdrop and `O`/`J` re-aimed
   * a camera whose director is being fed a zero delta.
   */
  const cameraBefore = await page.evaluate(() => {
    const canvas = globalThis.document.querySelector('#space-canvas');
    return { focusId: canvas?.solarVoyagerCamera?.focusId, mode: canvas?.solarVoyagerCamera?.mode };
  });
  await page.keyboard.press('KeyM');
  await page.keyboard.press('KeyO');
  await page.keyboard.press('j');
  await page.waitForTimeout(400);
  const whilePaused = await page.evaluate(() => {
    const canvas = globalThis.document.querySelector('#space-canvas');
    return {
      focusId: canvas?.solarVoyagerCamera?.focusId,
      mapMode: canvas?.dataset.systemMapMode ?? null,
      mode: canvas?.solarVoyagerCamera?.mode,
      sceneState: canvas?.dataset.sceneState ?? null,
    };
  });
  assert.equal(whilePaused.mapMode, 'space', 'M opened the system map underneath the pause menu');
  assert.equal(whilePaused.mode, cameraBefore.mode, 'the camera mode changed while paused');
  assert.equal(whilePaused.focusId, cameraBefore.focusId, 'the camera focus changed while paused');
  assert.equal(whilePaused.sceneState, 'paused', 'a stray key left the pause state');
  logPhase('paused keyboard is owned by the dialog');

  // Escape resumes and time moves again.
  await page.keyboard.press('Escape');
  await page.waitForSelector('#pause-menu', { state: 'hidden', timeout: 10_000 });
  await page.waitForFunction(
    (frozenSimTimeSec) =>
      (globalThis.document.querySelector('#space-canvas')?.solarVoyagerSystemMap
        ?.simulationTimeSec ?? 0) > frozenSimTimeSec,
    paused.simTimeSec,
    { timeout: 10_000 },
  );
  assert.equal((await readHudState(page)).sceneState, 'space');
  await page.evaluate(() => {
    const active = globalThis.document.activeElement;
    if (active instanceof globalThis.HTMLElement) active.blur();
  });
  logPhase('resume verified');

  // ---------------------------------------------------------------- map owns Escape
  await page.keyboard.press('KeyM');
  await page.locator('#system-map-panel').waitFor({ state: 'visible' });
  await page.keyboard.press('Escape');
  await page.locator('#system-map-panel').waitFor({ state: 'hidden' });
  assert.equal(
    (await readHudState(page)).sceneState,
    'space',
    'Escape closed the system map and also opened the pause menu',
  );
  logPhase('system map keeps its Escape');

  // ---------------------------------------------------------------- save and exit
  await page.keyboard.press('Escape');
  await page.waitForSelector('#pause-menu', { state: 'visible', timeout: 10_000 });
  await page.locator('#pause-save').click();
  await page.waitForFunction(
    () => globalThis.document.querySelector('#pause-status')?.textContent === 'Session saved',
    undefined,
    { timeout: 10_000 },
  );

  await page.locator('#pause-exit').click();
  await page.locator('.main-menu').waitFor({ state: 'visible', timeout: 15_000 });
  const menu = await readHudState(page);
  assert.equal(menu.sceneState, 'main-menu', 'exit to menu did not reach the menu state');
  assert.equal(menu.flightStrip, 0, 'the HUD survived the return to the menu');
  logPhase('exit to menu verified');

  // The v1 landmine: the transition used to be one-way, so re-entry must work.
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.waitForSelector('#flight-strip', { state: 'visible', timeout: 30_000 });
  await page.waitForFunction(
    () => globalThis.document.querySelector('#space-canvas')?.dataset.sceneState === 'space',
    undefined,
    { timeout: 15_000 },
  );
  const resources = await page.evaluate(
    () => globalThis.document.querySelector('#space-canvas')?.solarVoyagerRuntimeResources ?? null,
  );
  // Re-entering must not build a second input engine, camera pair or frame loop.
  assert.equal(resources.animationLoopStarts, 1);
  assert.equal(resources.cameraInputControllers, 2);
  assert.equal(resources.keyboardCommandMappers, 1);
  assert.equal(resources.spacePhaseActivations, 1);
  logPhase('menu return is reversible without duplicating runtime resources');

  assert.deepEqual(errors, []);
  process.stdout.write(
    `${JSON.stringify(
      { clean: clean.preset, pilot: pilot.preset, engineer: engineer.preset, marker, resources },
      null,
      2,
    )}\n`,
  );
} finally {
  if (browser !== undefined) await browser.close();
  await server.close();
}
