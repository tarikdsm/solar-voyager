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
    const telemetry = canvas.solarVoyagerTelemetry;
    const render = telemetry?.snapshot;
    const rendererInfo = telemetry?.renderer?.info;
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
      spaceRenderCountAtModeChange: runtime.spaceRenderCountAtModeChange,
      targetBodyId: runtime.targetBodyId,
      drawCalls: render?.drawCalls ?? -1,
      geometries: rendererInfo?.memory.geometries ?? -1,
      programs: rendererInfo?.programs?.length ?? -1,
      textures: rendererInfo?.memory.textures ?? -1,
      triangles: render?.triangles ?? -1,
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

function gpuResourcesOf(runtime) {
  return {
    geometries: runtime.geometries,
    programs: runtime.programs,
    textures: runtime.textures,
  };
}

async function waitForMapFrames(page, frameCount) {
  const start = (await readMapRuntime(page)).mapRenderCount;
  await page.waitForFunction(
    ({ expectedFrames, startFrame }) => {
      const canvas = globalThis.document.querySelector('#space-canvas');
      return (
        canvas instanceof globalThis.HTMLCanvasElement &&
        canvas.solarVoyagerSystemMap !== undefined &&
        canvas.solarVoyagerSystemMap.mapRenderCount >= startFrame + expectedFrames
      );
    },
    { expectedFrames: frameCount, startFrame: start },
    { timeout: 30_000 },
  );
}

async function waitForSpaceFrames(page, frameCount) {
  const start = (await readMapRuntime(page)).spaceRenderCount;
  await page.waitForFunction(
    ({ expectedFrames, startFrame }) => {
      const canvas = globalThis.document.querySelector('#space-canvas');
      return (
        canvas instanceof globalThis.HTMLCanvasElement &&
        canvas.solarVoyagerSystemMap !== undefined &&
        canvas.solarVoyagerSystemMap.spaceRenderCount >= startFrame + expectedFrames
      );
    },
    { expectedFrames: frameCount, startFrame: start },
    { timeout: 30_000 },
  );
}

async function waitForStableGpuResources(page, waitForFrames, frameBlock = 120) {
  let previous = null;
  let stableObservations = 0;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await waitForFrames(page, frameBlock);
    const current = await readMapRuntime(page);
    const resources = gpuResourcesOf(current);
    if (previous !== null && Object.keys(resources).every((key) => resources[key] === previous[key])) {
      stableObservations += 1;
      if (stableObservations === 3) return current;
    } else {
      stableObservations = 0;
    }
    previous = resources;
  }
  throw new Error(`GPU resources did not settle before prediction: ${JSON.stringify(previous)}`);
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
  let releaseWorkerRequest = () => undefined;
  const workerGate = new Promise((resolve) => {
    releaseWorkerRequest = resolve;
  });
  let workerRequestBlocked = false;
  await page.route(/predictor\.worker/iu, async (route) => {
    workerRequestBlocked = true;
    await workerGate;
    await route.continue();
  });
  await installTrajectoryPredictionTestHorizon(page, 21_600);
  await installTrajectoryPredictionTestPointCount(page, 128);
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

  await toggle.click();
  await panel.waitFor({ state: 'visible' });
  assert.equal(await selector.evaluate((element) => element === globalThis.document.activeElement), true);
  await page.waitForFunction(
    (simulationTimeSec) => {
      const canvas = globalThis.document.querySelector('#space-canvas');
      return (
        canvas instanceof globalThis.HTMLCanvasElement &&
        canvas.solarVoyagerSystemMap !== undefined &&
        canvas.solarVoyagerSystemMap.simulationTimeSec > simulationTimeSec &&
        canvas.solarVoyagerSystemMap.mapRenderCount > 0
      );
    },
    beforeOpen.simulationTimeSec,
    { timeout: 10_000 },
  );
  const afterOpen = await readMapRuntime(page);
  assert.equal(afterOpen.mode, 'system-map');
  assert.ok(afterOpen.simulationTimeSec > beforeOpen.simulationTimeSec, 'simulation paused in map');
  assert.ok(afterOpen.mapRenderCount > beforeOpen.mapRenderCount, 'map scene was not rendered');
  assert.equal(
    afterOpen.spaceRenderCount,
    afterOpen.spaceRenderCountAtModeChange,
    'space rendered behind map',
  );
  assert.equal(workerRequestBlocked, true, 'trajectory worker request was not delayed');
  assert.equal(afterOpen.trajectoryLineVisible, false, 'trajectory line appeared before response');
  assert.equal(afterOpen.trajectoryMarkersVisible, false, 'trajectory markers appeared before response');
  assert.ok(afterOpen.drawCalls > 0 && afterOpen.drawCalls <= 150, `map draws: ${afterOpen.drawCalls}`);
  assert.ok(afterOpen.triangles <= 500_000, `map triangles: ${afterOpen.triangles}`);

  const beforePrediction = await waitForStableGpuResources(page, waitForMapFrames);
  assert.ok(
    beforePrediction.mapRenderCount >= 480,
    `map did not render enough delayed-prediction frames: ${beforePrediction.mapRenderCount}`,
  );
  releaseWorkerRequest();
  await page.waitForFunction(
    () => globalThis.document.querySelector('#space-canvas')?.dataset.trajectoryReady === 'true',
    undefined,
    { timeout: 90_000 },
  );
  await waitForMapFrames(page, 2);
  const afterPredictionLine = await readMapRuntime(page);
  assert.equal(afterPredictionLine.trajectoryLineVisible, true, 'shared prediction line is hidden');
  assert.equal(afterPredictionLine.trajectoryMarkersVisible, false, 'untargeted prediction has markers');

  await selector.selectOption('mercury');
  await page.waitForFunction(
    () => globalThis.document.querySelector('#space-canvas')?.dataset.trajectoryReady !== 'true',
  );
  await page.waitForFunction(
    () => globalThis.document.querySelector('#space-canvas')?.dataset.trajectoryReady === 'true',
    undefined,
    { timeout: 90_000 },
  );
  await page.waitForTimeout(1_700);
  assert.equal(await page.locator('#system-map-target').textContent(), 'Mercury');
  assert.equal(
    (await readMapRuntime(page)).trajectoryMarkersVisible,
    true,
    'targeted prediction markers are hidden',
  );
  const afterPredictionMarkers = await readMapRuntime(page);
  assert.deepEqual(
    {
      line: gpuResourcesOf(afterPredictionLine),
      markers: gpuResourcesOf(afterPredictionMarkers),
    },
    {
      line: gpuResourcesOf(beforePrediction),
      markers: gpuResourcesOf(beforePrediction),
    },
    'first trajectory line or marker created GPU resources',
  );
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

  await toggle.click();
  await panel.waitFor({ state: 'hidden' });
  const beforeToggleWarm = await readMapRuntime(page);
  const afterToggleWarm = await waitForStableGpuResources(page, waitForSpaceFrames, 30);
  assert.ok(
    afterToggleWarm.spaceRenderCount >= beforeToggleWarm.spaceRenderCount + 120,
    'focused space resources did not receive enough warm-up frames',
  );
  await toggle.click();
  await panel.waitFor({ state: 'visible' });
  await waitForMapFrames(page, 2);
  const beforeToggles = await readMapRuntime(page);
  const heapBeforeBytes = await page.evaluate(() => {
    globalThis.gc?.();
    globalThis.gc?.();
    return performance.memory?.usedJSHeapSize ?? -1;
  });
  assert.ok(heapBeforeBytes >= 0, 'precise Chromium heap metrics are unavailable');
  await page.evaluate(async () => {
    const toggleButton = globalThis.document.querySelector('#system-map-toggle');
    if (!(toggleButton instanceof globalThis.HTMLButtonElement)) throw new Error('toggle missing');
    for (let index = 0; index < 100; index += 1) {
      toggleButton.click();
      await new Promise((resolve) => globalThis.requestAnimationFrame(resolve));
    }
  });
  await waitForMapFrames(page, 2);
  const toggleEvidence = await page.evaluate(() => {
    globalThis.gc?.();
    globalThis.gc?.();
    const canvas = globalThis.document.querySelector('#space-canvas');
    if (!(canvas instanceof globalThis.HTMLCanvasElement)) throw new Error('canvas missing');
    const rendererInfo = canvas.solarVoyagerTelemetry?.renderer?.info;
    return {
      gpuResources: {
        geometries: rendererInfo?.memory.geometries ?? -1,
        programs: rendererInfo?.programs?.length ?? -1,
        textures: rendererInfo?.memory.textures ?? -1,
      },
      heapAfterBytes: performance.memory?.usedJSHeapSize ?? -1,
      identityStable:
        globalThis.__systemMapResourceIdentity?.diagnostics === canvas.solarVoyagerSystemMap &&
        globalThis.__systemMapResourceIdentity?.resources === canvas.solarVoyagerRuntimeResources,
      resources: canvas.solarVoyagerRuntimeResources,
    };
  });
  assert.equal(toggleEvidence.identityStable, true, 'toggle replaced setup-owned resources');
  assert.deepEqual(toggleEvidence.resources, beforeOpen.resources, 'toggle changed runtime resources');
  assert.deepEqual(
    toggleEvidence.gpuResources,
    {
      geometries: beforeToggles.geometries,
      programs: beforeToggles.programs,
      textures: beforeToggles.textures,
    },
    'toggle changed GPU resource counts',
  );
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
  await page.keyboard.press('e');
  await page.waitForFunction(() => {
    const canvas = globalThis.document.querySelector('#space-canvas');
    return (
      canvas instanceof globalThis.HTMLCanvasElement &&
      canvas.solarVoyagerSystemMap?.focusBodyId === 'earth' &&
      canvas.solarVoyagerSystemMap.targetBodyId === 'earth'
    );
  });
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
        delayedPredictionGpuResources: gpuResourcesOf(beforePrediction),
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
