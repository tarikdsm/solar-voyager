import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { chromium } from 'playwright';
import { preview } from 'vite';

import { assertPortAvailable } from '../bench/scaffoldBenchUtils.mjs';
import {
  installTrajectoryPredictionTestHorizon,
  installTrajectoryPredictionTestPointCount,
} from './trajectoryPredictionTestIsolation.mjs';

const HOST = '127.0.0.1';
const PORT = 4198;
const PAGE_URL = `http://${HOST}:${String(PORT)}/solar-voyager/?autostart=1`;
const SCREENSHOT_DIRECTORY = path.resolve('.playwright-mcp');
const MAXIMUM_TOGGLE_HEAP_GROWTH_BYTES = 256 * 1024;

function collectBrowserErrors(page) {
  const errors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('crash', () => errors.push('page crash'));
  return errors;
}

async function readMapRuntime(page) {
  return page.evaluate(() => {
    const canvas = globalThis.document.querySelector('#space-canvas');
    if (!(canvas instanceof globalThis.HTMLCanvasElement)) throw new Error('canvas missing');
    const runtime = canvas.solarVoyagerSystemMap;
    if (runtime === undefined) throw new Error('system-map diagnostics missing');
    return {
      bodyCount: runtime.scene.bodyCount,
      focusBodyId: runtime.focusBodyId,
      iconDrawCount: runtime.scene.iconDrawCount,
      mapRenderCount: runtime.mapRenderCount,
      mapSceneCreations: runtime.mapSceneCreations,
      mode: runtime.mode,
      orbitDrawCount: runtime.scene.orbitDrawCount,
      resources: canvas.solarVoyagerRuntimeResources,
      simulationTimeSec: runtime.simulationTimeSec,
      spaceRenderCount: runtime.spaceRenderCount,
      targetBodyId: runtime.targetBodyId,
      trajectoryLineVisible: runtime.trajectoryLineVisible,
      trajectoryMarkersVisible: runtime.trajectoryMarkersVisible,
    };
  });
}

async function readSelectedPrecision(page) {
  return page.evaluate(() => {
    const canvas = globalThis.document.querySelector('#space-canvas');
    if (!(canvas instanceof globalThis.HTMLCanvasElement)) throw new Error('canvas missing');
    const runtime = canvas.solarVoyagerSystemMap;
    if (runtime === undefined) throw new Error('system-map diagnostics missing');
    return {
      alignmentKm: runtime.scene.selectedOrbitAlignmentKm,
      alignmentPx: runtime.scene.selectedOrbitAlignmentPx,
      projectedX: runtime.scene.selectedProjectedX,
      projectedY: runtime.scene.selectedProjectedY,
      relativeX: runtime.scene.selectedRelativeX,
      relativeY: runtime.scene.selectedRelativeY,
      relativeZ: runtime.scene.selectedRelativeZ,
      visible: runtime.scene.selectedVisible,
    };
  });
}

function assertFinitePrecision(bodyId, precision) {
  for (const [name, value] of Object.entries(precision)) {
    if (name === 'visible') continue;
    assert.ok(Number.isFinite(value), `${bodyId} ${name} is not finite: ${String(value)}`);
  }
  assert.equal(precision.visible, true, `${bodyId} is outside the map viewport`);
  assert.ok(
    precision.alignmentPx <= 12,
    `${bodyId} orbit is misaligned by ${String(precision.alignmentPx)} CSS px`,
  );
}

await assertPortAvailable(PORT, HOST);
await mkdir(SCREENSHOT_DIRECTORY, { recursive: true });
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
      '--enable-webgl',
      '--ignore-gpu-blocklist',
      '--js-flags=--expose-gc',
      '--use-angle=swiftshader',
    ],
  });
  const context = await browser.newContext({ viewport: { width: 1_280, height: 720 } });
  const page = await context.newPage();
  const browserErrors = collectBrowserErrors(page);
  await installTrajectoryPredictionTestHorizon(page, 3_600);
  await installTrajectoryPredictionTestPointCount(page, 64);
  const response = await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });
  assert.ok(response?.ok(), `system-map page returned ${String(response?.status())}`);
  await page.waitForFunction(
    () => {
      const canvas = globalThis.document.querySelector('#space-canvas');
      return (
        canvas instanceof globalThis.HTMLCanvasElement &&
        canvas.dataset.cameraReady === 'true' &&
        canvas.solarVoyagerSystemMap !== undefined
      );
    },
    undefined,
    { timeout: 60_000 },
  );
  const warning = page.locator('#hardware-acceleration-warning');
  if (await warning.isVisible()) {
    await warning.getByRole('button', { name: 'I understand', exact: true }).click();
    await warning.waitFor({ state: 'detached' });
  }
  await page.waitForFunction(
    () => globalThis.document.querySelector('#space-canvas')?.dataset.trajectoryReady === 'true',
    undefined,
    { timeout: 90_000 },
  );

  const toggle = page.locator('#system-map-toggle');
  const panel = page.locator('#system-map-panel');
  const selector = page.locator('#system-map-body-selector');
  assert.equal(await selector.locator('option').count(), 43, 'map must list every catalog body');

  const beforeOpen = await readMapRuntime(page);
  assert.equal(beforeOpen.mode, 'space');
  assert.equal(beforeOpen.bodyCount, 43);
  assert.equal(beforeOpen.iconDrawCount, 1);
  assert.equal(beforeOpen.orbitDrawCount, 1);
  assert.equal(beforeOpen.mapSceneCreations, 1);
  await page.evaluate(() => {
    const canvas = globalThis.document.querySelector('#space-canvas');
    if (!(canvas instanceof globalThis.HTMLCanvasElement)) throw new Error('canvas missing');
    globalThis.__systemMapResourceIdentity = {
      diagnostics: canvas.solarVoyagerSystemMap,
      resources: canvas.solarVoyagerRuntimeResources,
    };
  });

  await page.keyboard.press('m');
  await panel.waitFor({ state: 'visible' });
  assert.equal(await selector.evaluate((element) => element === globalThis.document.activeElement), true);
  await page.waitForTimeout(100);
  const afterOpen = await readMapRuntime(page);
  assert.equal(afterOpen.mode, 'system-map');
  assert.ok(afterOpen.simulationTimeSec > beforeOpen.simulationTimeSec, 'simulation paused in map');
  assert.ok(afterOpen.mapRenderCount > beforeOpen.mapRenderCount, 'map scene was not rendered');
  assert.equal(afterOpen.spaceRenderCount, beforeOpen.spaceRenderCount, 'space rendered behind map');
  assert.equal(afterOpen.trajectoryLineVisible, true, 'shared prediction line is hidden');

  await selector.selectOption('mercury');
  await page.waitForTimeout(1_700);
  assert.equal(await page.locator('#system-map-target').textContent(), 'Mercury');
  assertFinitePrecision('mercury', await readSelectedPrecision(page));
  await page.screenshot({
    path: path.join(SCREENSHOT_DIRECTORY, 'T0097-system-map-inner.png'),
    fullPage: true,
  });

  await selector.selectOption('pluto');
  await page.waitForTimeout(1_700);
  const outerRuntime = await readMapRuntime(page);
  assert.equal(outerRuntime.focusBodyId, 'pluto');
  assert.equal(outerRuntime.targetBodyId, 'pluto');
  assertFinitePrecision('pluto', await readSelectedPrecision(page));
  await page.screenshot({
    path: path.join(SCREENSHOT_DIRECTORY, 'T0097-system-map-outer.png'),
    fullPage: true,
  });

  const heapBeforeBytes = await page.evaluate(() => {
    globalThis.gc?.();
    globalThis.gc?.();
    return performance.memory?.usedJSHeapSize ?? -1;
  });
  assert.ok(heapBeforeBytes >= 0, 'precise Chromium heap metrics are unavailable');
  await page.evaluate(() => {
    const toggleButton = globalThis.document.querySelector('#system-map-toggle');
    if (!(toggleButton instanceof globalThis.HTMLButtonElement)) throw new Error('toggle missing');
    for (let index = 0; index < 100; index += 1) toggleButton.click();
  });
  await page.waitForTimeout(100);
  const toggleEvidence = await page.evaluate(() => {
    globalThis.gc?.();
    globalThis.gc?.();
    const canvas = globalThis.document.querySelector('#space-canvas');
    if (!(canvas instanceof globalThis.HTMLCanvasElement)) throw new Error('canvas missing');
    return {
      heapAfterBytes: performance.memory?.usedJSHeapSize ?? -1,
      identityStable:
        globalThis.__systemMapResourceIdentity?.diagnostics === canvas.solarVoyagerSystemMap &&
        globalThis.__systemMapResourceIdentity?.resources === canvas.solarVoyagerRuntimeResources,
      resources: canvas.solarVoyagerRuntimeResources,
    };
  });
  assert.equal(toggleEvidence.identityStable, true, 'toggle replaced setup-owned resources');
  assert.deepEqual(toggleEvidence.resources, beforeOpen.resources, 'toggle changed runtime resources');
  assert.ok(
    toggleEvidence.heapAfterBytes - heapBeforeBytes <= MAXIMUM_TOGGLE_HEAP_GROWTH_BYTES,
    `toggles retained heap: ${String(toggleEvidence.heapAfterBytes - heapBeforeBytes)} bytes`,
  );

  await page.keyboard.press('Escape');
  await panel.waitFor({ state: 'hidden' });
  assert.equal(await toggle.evaluate((element) => element === globalThis.document.activeElement), true);
  await page.waitForTimeout(100);
  const returned = await readMapRuntime(page);
  assert.equal(returned.mode, 'space');
  assert.equal(returned.focusBodyId, 'pluto');
  assert.equal(returned.targetBodyId, 'pluto');
  assert.ok(returned.spaceRenderCount > afterOpen.spaceRenderCount, 'space render did not resume');
  assert.deepEqual(browserErrors, []);

  const compactContext = await browser.newContext({
    reducedMotion: 'reduce',
    viewport: { width: 360, height: 480 },
  });
  const compactPage = await compactContext.newPage();
  const compactErrors = collectBrowserErrors(compactPage);
  await compactPage.addInitScript(() => {
    Object.defineProperty(globalThis, '__solarVoyagerTestDisableTrajectoryPrediction', {
      configurable: true,
      value: true,
    });
  });
  await compactPage.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });
  await compactPage.waitForSelector('#system-map-toggle', { state: 'visible', timeout: 60_000 });
  const compactWarning = compactPage.locator('#hardware-acceleration-warning');
  if (await compactWarning.isVisible()) {
    await compactWarning.getByRole('button', { name: 'I understand', exact: true }).click();
  }
  await compactPage.keyboard.press('m');
  const compactPanel = compactPage.locator('#system-map-panel');
  await compactPanel.waitFor({ state: 'visible' });
  const compact = await compactPanel.evaluate((element) => {
    const style = globalThis.getComputedStyle(element);
    return {
      animationName: style.animationName,
      clientHeight: element.clientHeight,
      overflowY: style.overflowY,
      reducedMotion: globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches,
      scrollHeight: element.scrollHeight,
      transitionDuration: style.transitionDuration,
      viewportHeight: globalThis.innerHeight,
    };
  });
  assert.equal(compact.reducedMotion, true);
  assert.equal(compact.animationName, 'none');
  assert.equal(compact.transitionDuration, '0s');
  assert.equal(compact.overflowY, 'auto');
  assert.ok(compact.clientHeight <= compact.viewportHeight);
  assert.ok(compact.scrollHeight >= compact.clientHeight);
  assert.deepEqual(compactErrors, []);
  await compactContext.close();

  process.stdout.write(
    `${JSON.stringify(
      {
        bodyCount: returned.bodyCount,
        heapGrowthBytes: toggleEvidence.heapAfterBytes - heapBeforeBytes,
        innerScreenshot: path.join(SCREENSHOT_DIRECTORY, 'T0097-system-map-inner.png'),
        mapRenderCount: returned.mapRenderCount,
        outerScreenshot: path.join(SCREENSHOT_DIRECTORY, 'T0097-system-map-outer.png'),
        spaceRenderCount: returned.spaceRenderCount,
      },
      null,
      2,
    )}\n`,
  );
  await context.close();
} finally {
  if (browser !== undefined) await browser.close();
  await server.close();
}
