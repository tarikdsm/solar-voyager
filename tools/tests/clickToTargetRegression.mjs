import assert from 'node:assert/strict';

import { chromium } from 'playwright';
import { preview } from 'vite';

import { assertPortAvailable } from '../bench/scaffoldBenchUtils.mjs';
import { disableUnrelatedTrajectoryPrediction } from './trajectoryPredictionTestIsolation.mjs';

/**
 * T0117 browser regression: click-to-target in the system map, the
 * "set as cruise target" affordance in both views, and the allocation budget.
 *
 * The space-view click is already gated by `hudPresetsRegression.mjs` (T0112);
 * this gate owns the three things that task did not deliver. It drives real
 * mouse input rather than synthetic `PointerEvent`s because
 * `CameraInputController` calls `setPointerCapture` on the same gesture and
 * throws for a pointer id the browser never issued.
 */

const HOST = '127.0.0.1';
const PORT = 4211;
const PAGE_URL = `http://${HOST}:${String(PORT)}/solar-voyager/?autostart=1`;
/** Same envelope `systemMapRegression.mjs` uses for its 100-toggle loop. */
const MAXIMUM_PICK_HEAP_GROWTH_BYTES = 256 * 1024;
const PICK_LOOP_COUNT = 120;

function collectBrowserErrors(page) {
  const errors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('crash', () => errors.push('page crash'));
  return errors;
}

function logPhase(message) {
  process.stdout.write(`click-to-target: ${message}\n`);
}

async function dismissHardwareWarning(page) {
  const warning = page.locator('#hardware-acceleration-warning');
  if (!(await warning.isVisible())) return;
  await warning.getByRole('button', { name: 'I understand' }).click();
  await warning.waitFor({ state: 'detached', timeout: 10_000 });
}

async function readTargetState(page) {
  return page.evaluate(() => {
    const canvas = globalThis.document.querySelector('#space-canvas');
    const map = canvas?.solarVoyagerSystemMap;
    return {
      focusBodyId: map?.focusBodyId ?? null,
      targetBodyId: map?.targetBodyId ?? null,
      pickedBodyId: canvas?.dataset.pickedBodyId ?? null,
      pickView: canvas?.dataset.pickView ?? null,
      pickAttempts: Number(canvas?.dataset.pickAttempts ?? '0'),
      mapCruiseTarget:
        globalThis.document.querySelector('#map-cruise-target')?.textContent ?? null,
      hudCruiseTarget:
        globalThis.document.querySelector('#hud-cruise-target')?.textContent ?? null,
    };
  });
}

/**
 * Screen position of a body's system-map icon, from the same float64 projection
 * the picker uses — read back through the page rather than reimplemented here,
 * so a gate failure means "the click did not land", not "the harness disagrees
 * about where Mars is".
 */
async function mapIconPoint(page, bodyId) {
  return page.evaluate((id) => {
    const canvas = globalThis.document.querySelector('#space-canvas');
    if (!(canvas instanceof globalThis.HTMLCanvasElement)) throw new Error('canvas missing');
    const diagnostics = canvas.solarVoyagerSystemMap;
    if (diagnostics === undefined) throw new Error('system map diagnostics missing');
    // `selectedProjectedX/Y` are the NDC of the *selected* icon, which is the
    // focus body; the map focuses what it selects, so focusing the body first is
    // how the harness learns where its icon is.
    if (diagnostics.focusBodyId !== id) return null;
    const rect = canvas.getBoundingClientRect();
    return {
      x: rect.left + ((diagnostics.scene.selectedProjectedX + 1) / 2) * rect.width,
      y: rect.top + ((1 - diagnostics.scene.selectedProjectedY) / 2) * rect.height,
      visible: diagnostics.scene.selectedVisible,
    };
  }, bodyId);
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
    channel: 'chrome',
    headless: true,
    args: [
      '--enable-precise-memory-info',
      '--enable-unsafe-swiftshader',
      '--use-angle=swiftshader',
      '--js-flags=--expose-gc',
    ],
  });
  const page = await browser.newPage({ viewport: { width: 1_280, height: 720 } });
  const errors = collectBrowserErrors(page);
  await disableUnrelatedTrajectoryPrediction(page);
  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#flight-strip', { state: 'visible', timeout: 60_000 });
  await page.waitForFunction(
    () => globalThis.document.querySelector('#space-canvas')?.dataset.cameraReady === 'true',
    undefined,
    { timeout: 60_000 },
  );
  await dismissHardwareWarning(page);
  logPhase('space phase ready');

  // ------------------------------------------------- the space-view affordance
  /*
   * Clean is the default preset, so the cruise section — and the affordance
   * inside it — must be reachable without turning any instrumentation on. This
   * is the half of "an affordance in both views" the space view owes.
   */
  const hudButton = page.locator('#hud-set-cruise-target');
  await hudButton.waitFor({ state: 'visible', timeout: 15_000 });
  await page.selectOption('#target-selector', 'mars').catch(() => undefined);
  // Clean hides the target panel, so drive the fallback the way a player would
  // reach it: cycle to Engineer, use the select, cycle back.
  await page.keyboard.press('KeyH');
  await page.keyboard.press('KeyH');
  await page.waitForSelector('#target-selector', { state: 'visible', timeout: 15_000 });
  await page.selectOption('#target-selector', 'mars');
  await page.waitForFunction(
    () => globalThis.document.querySelector('#hud-cruise-target')?.textContent === 'Mars',
    undefined,
    { timeout: 15_000 },
  );
  const afterPanel = await readTargetState(page);
  assert.equal(afterPanel.targetBodyId, 'mars', 'the target panel fallback did not reach setTarget');
  assert.equal(afterPanel.hudCruiseTarget, 'Mars');
  logPhase('target panel fallback verified; space-view affordance names the target');

  assert.equal(
    await hudButton.textContent(),
    'Set Mars as cruise target',
    'the space-view affordance does not name the selection it would commit',
  );
  await hudButton.click();
  await page.waitForFunction(
    () => globalThis.document.querySelector('#space-canvas')?.solarVoyagerSystemMap?.targetBodyId
      === 'mars',
    undefined,
    { timeout: 15_000 },
  );
  logPhase('space-view "set as cruise target" commits through the same write point');

  // ------------------------------------------------------------- map selection
  await page.keyboard.press('KeyH');
  await page.keyboard.press('KeyM');
  await page.waitForSelector('#system-map-panel', { state: 'visible', timeout: 15_000 });
  /*
   * Mercury, deliberately: it has no satellites. Focusing Jupiter puts all four
   * Galilean icons inside the 8 px pick radius of Jupiter's own, and the
   * nearest-along-ray rule then correctly returns whichever moon is in front —
   * right behaviour, useless assertion.
   */
  await page.selectOption('#system-map-body-selector', 'mercury');
  await page.waitForFunction(
    () =>
      globalThis.document.querySelector('#space-canvas')?.solarVoyagerSystemMap?.focusBodyId ===
      'mercury',
    undefined,
    { timeout: 15_000 },
  );
  // Let the 1.5 s focus transfer settle, or the icon moves out from under the
  // click while the camera is still flying.
  await page.waitForTimeout(2_500);

  const mapButton = page.locator('#map-set-cruise-target');
  await mapButton.waitFor({ state: 'visible', timeout: 15_000 });
  assert.equal(
    await mapButton.textContent(),
    'Set Mercury as cruise target',
    'the map affordance does not name the selection it would commit',
  );

  const icon = await mapIconPoint(page, 'mercury');
  assert.ok(icon !== null, 'the harness could not locate the focused map icon');
  assert.equal(icon.visible, true, 'the focused map icon is outside the map viewport');

  /*
   * The load-bearing assertion of this task: a click on the icon in the map
   * moves BOTH the map focus and the navigation target. Mars is the target at
   * this point, so a successful Mercury pick has to change it.
   */
  await page.evaluate(() => {
    const canvas = globalThis.document.querySelector('#space-canvas');
    if (canvas instanceof globalThis.HTMLCanvasElement) canvas.dataset.pickedBodyId = 'sentinel';
  });
  await page.mouse.click(icon.x, icon.y);
  await page.waitForFunction(
    () => globalThis.document.querySelector('#space-canvas')?.dataset.pickedBodyId === 'mercury',
    undefined,
    { timeout: 15_000 },
  );
  const afterMapClick = await readTargetState(page);
  assert.equal(afterMapClick.pickView, 'map', 'the map click was picked as a space-view click');
  assert.equal(afterMapClick.focusBodyId, 'mercury', 'the map click did not select focus');
  assert.equal(afterMapClick.targetBodyId, 'mercury', 'the map click did not reach setTarget');
  assert.equal(afterMapClick.mapCruiseTarget, 'Mercury');
  logPhase('map click selects focus and target');

  // ------------------------------------------------------------ pick allocation
  /*
   * "Zero allocation per click frame". The picking math writes into
   * module-owned scratch and the handler reads `offsetX`/`offsetY` instead of
   * allocating a `DOMRect`, so a long burst of picks must not move the heap
   * beyond the envelope the map-toggle gate already uses.
   */
  const heapBeforeBytes = await page.evaluate(() => {
    globalThis.gc?.();
    globalThis.gc?.();
    return performance.memory?.usedJSHeapSize ?? -1;
  });
  assert.ok(heapBeforeBytes >= 0, 'precise Chromium heap metrics are unavailable');
  const attemptsBefore = (await readTargetState(page)).pickAttempts;
  for (let index = 0; index < PICK_LOOP_COUNT; index += 1) {
    // Alternating a hit and a miss exercises both exits of the hit test.
    await page.mouse.click(icon.x, icon.y);
    await page.mouse.click(icon.x + 240, icon.y + 160);
  }
  const heapAfter = await page.evaluate(() => {
    globalThis.gc?.();
    globalThis.gc?.();
    return performance.memory?.usedJSHeapSize ?? -1;
  });
  const afterLoop = await readTargetState(page);
  assert.ok(
    afterLoop.pickAttempts >= attemptsBefore + PICK_LOOP_COUNT * 2,
    `the pick loop did not reach the handler: ${String(afterLoop.pickAttempts)}`,
  );
  const heapGrowthBytes = heapAfter - heapBeforeBytes;
  assert.ok(
    heapGrowthBytes <= MAXIMUM_PICK_HEAP_GROWTH_BYTES,
    `picking grew the heap by ${String(heapGrowthBytes)} B over ${String(PICK_LOOP_COUNT * 2)} picks`,
  );
  logPhase(`pick loop heap growth ${String(heapGrowthBytes)} B`);

  // A drag must not re-target, in the map as in the space view: orbiting the map
  // camera is the gesture `CameraInputController` owns on the same canvas.
  await page.evaluate(() => {
    const canvas = globalThis.document.querySelector('#space-canvas');
    if (canvas instanceof globalThis.HTMLCanvasElement) canvas.dataset.pickedBodyId = 'sentinel';
  });
  await page.mouse.move(icon.x - 90, icon.y);
  await page.mouse.down();
  await page.mouse.move(icon.x - 45, icon.y, { steps: 4 });
  await page.mouse.move(icon.x, icon.y, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  assert.equal(
    (await readTargetState(page)).pickedBodyId,
    'sentinel',
    'releasing a map drag over an icon re-targeted it',
  );
  logPhase('map drag suppressed');


  assert.deepEqual(errors, []);
  process.stdout.write(
    `${JSON.stringify(
      {
        afterPanel,
        afterMapClick,
        heapGrowthBytes,
        picks: PICK_LOOP_COUNT * 2,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  if (browser !== undefined) await browser.close();
  await server.close();
}
