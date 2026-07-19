import assert from 'node:assert/strict';

import { chromium } from 'playwright';
import { preview } from 'vite';

import { assertPortAvailable } from '../bench/scaffoldBenchUtils.mjs';
import {
  disableUnrelatedTrajectoryPrediction,
  installTrajectoryPredictionTestHorizon,
  installTrajectoryPredictionTestPointCount,
} from './trajectoryPredictionTestIsolation.mjs';

const HOST = '127.0.0.1';
const PORT = 4196;
const PAGE_URL = `http://${HOST}:${String(PORT)}/solar-voyager/`;
const SAVE_STORAGE_KEY = 'solar-voyager.save.v2';
const EARTH_MEAN_RADIUS_KM = 6_371.0084;

const MENU_RUNTIME_RESOURCES = {
  animationLoopStarts: 0,
  cameraInputControllers: 0,
  canvasBindings: 1,
  epochWorldCreations: 1,
  keyboardCommandMappers: 0,
  pagehideListeners: 0,
  rendererCreations: 1,
  resizeListeners: 0,
  scrollListeners: 0,
  sessionSimulationCreations: 1,
  sessionSimulationReplacements: 0,
  spacePhaseActivationRequests: 0,
  spacePhaseActivations: 0,
  stateVectorLayoutObservers: 0,
  trajectoryWorkers: 0,
};

const ACTIVE_RUNTIME_RESOURCES = {
  animationLoopStarts: 1,
  cameraInputControllers: 2,
  canvasBindings: 1,
  epochWorldCreations: 1,
  keyboardCommandMappers: 1,
  pagehideListeners: 1,
  rendererCreations: 1,
  resizeListeners: 1,
  scrollListeners: 1,
  sessionSimulationCreations: 2,
  sessionSimulationReplacements: 1,
  spacePhaseActivationRequests: 1,
  spacePhaseActivations: 1,
  stateVectorLayoutObservers: 1,
  trajectoryWorkers: 1,
};
const ACTIVE_RUNTIME_RESOURCES_WITHOUT_TRAJECTORY = {
  ...ACTIVE_RUNTIME_RESOURCES,
  trajectoryWorkers: 0,
};

function collectBrowserErrors(page) {
  const errors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('crash', () => errors.push('page crash'));
  return errors;
}

async function readRuntimeState(page) {
  return page.evaluate(() => {
    const canvas = globalThis.document.querySelector('#space-canvas');
    if (!(canvas instanceof globalThis.HTMLCanvasElement)) throw new Error('canvas missing');
    return {
      cameraReady: canvas.dataset.cameraReady ?? null,
      canvasCount: globalThis.document.querySelectorAll('#space-canvas').length,
      frameCount: canvas.solarVoyagerTelemetry?.snapshot.frameCount ?? -1,
      frameSampleCount: canvas.solarVoyagerTelemetry?.frameSampleCount ?? -1,
      hudCount: globalThis.document.querySelectorAll('#orbit-readout').length,
      menuCount: globalThis.document.querySelectorAll('.main-menu').length,
      resources: canvas.solarVoyagerRuntimeResources ?? null,
    };
  });
}

async function waitForFreshMenu(page) {
  await page.waitForSelector('.main-menu', { state: 'visible', timeout: 30_000 });
  await page.waitForFunction(
    () => {
      const canvas = globalThis.document.querySelector('#space-canvas');
      return (
        canvas instanceof globalThis.HTMLCanvasElement &&
        canvas.dataset.rendererReady === 'true' &&
        canvas.dataset.worldReady === 'true' &&
        canvas.solarVoyagerTelemetry !== undefined
      );
    },
    undefined,
    { timeout: 30_000 },
  );
}

async function assertFreshMenu(page, expectedContinueEnabled) {
  await waitForFreshMenu(page);
  await page.waitForTimeout(150);
  const runtime = await readRuntimeState(page);
  assert.deepEqual(runtime, {
    cameraReady: null,
    canvasCount: 1,
    frameCount: 0,
    frameSampleCount: 0,
    hudCount: 0,
    menuCount: 1,
    resources: MENU_RUNTIME_RESOURCES,
  });
  const newGame = page.getByRole('button', { name: 'New Game' });
  const continueButton = page.getByRole('button', { name: 'Continue' });
  await page.getByRole('heading', { name: 'Solar Voyager', level: 1 }).waitFor();
  await page.getByRole('heading', { name: 'Begin your voyage', level: 2 }).waitFor();
  await page.getByRole('heading', { name: 'Quick flight controls', level: 2 }).waitFor();
  assert.equal(await page.locator('.main-menu-facts li').count(), 3);
  assert.match(await page.locator('.main-menu').innerText(), /Float64 n-body physics/iu);
  assert.match(await page.locator('.main-menu').innerText(), /Relativistic visuals/iu);
  assert.equal(
    await newGame.evaluate((element) => element === globalThis.document.activeElement),
    true,
  );
  assert.equal(await continueButton.isEnabled(), expectedContinueEnabled);
}

async function waitForSpace(page, timeout = 30_000, expectedResources = ACTIVE_RUNTIME_RESOURCES) {
  try {
    await page.waitForSelector('#orbit-readout', { state: 'visible', timeout });
    await page.waitForFunction(
      (expectedResources) => {
        const canvas = globalThis.document.querySelector('#space-canvas');
        if (!(canvas instanceof globalThis.HTMLCanvasElement)) return false;
        const resources = canvas.solarVoyagerRuntimeResources;
        return (
          canvas.dataset.cameraReady === 'true' &&
          resources !== undefined &&
          Object.entries(expectedResources).every(
            ([resource, expected]) => resources[resource] === expected,
          )
        );
      },
      expectedResources,
      { timeout },
    );
  } catch (cause) {
    const diagnostics = await page.evaluate(() => {
      const canvas = globalThis.document.querySelector('#space-canvas');
      const orbit = globalThis.document.querySelector('#orbit-readout');
      return {
        cameraReady:
          canvas instanceof globalThis.HTMLCanvasElement
            ? (canvas.dataset.cameraReady ?? null)
            : null,
        frameCount:
          canvas instanceof globalThis.HTMLCanvasElement
            ? (canvas.solarVoyagerTelemetry?.snapshot.frameCount ?? null)
            : null,
        orbitPresent: orbit !== null,
        orbitVisible:
          orbit instanceof globalThis.HTMLElement
            ? globalThis.getComputedStyle(orbit).visibility !== 'hidden'
            : false,
        resources:
          canvas instanceof globalThis.HTMLCanvasElement
            ? (canvas.solarVoyagerRuntimeResources ?? null)
            : null,
      };
    });
    throw new Error(`Space activation did not complete: ${JSON.stringify(diagnostics)}`, {
      cause,
    });
  }
}

async function dismissHardwareWarningIfPresent(page) {
  const warning = page.locator('#hardware-acceleration-warning');
  if (!(await warning.isVisible())) {
    assert.equal(await warning.count(), 0, 'hidden hardware warning remained in the document');
    return false;
  }
  assert.equal(await warning.count(), 1, 'expected one visible hardware warning');
  const acknowledgment = warning.getByRole('button', { name: 'I understand', exact: true });
  assert.equal(await acknowledgment.count(), 1, 'hardware warning acknowledgment is ambiguous');
  await acknowledgment.click();
  await warning.waitFor({ state: 'detached' });
  return true;
}

async function runFreshAndContinueFlow(browser) {
  const context = await browser.newContext({ viewport: { width: 1_280, height: 720 } });
  const page = await context.newPage();
  const browserErrors = collectBrowserErrors(page);
  let workerRequestCount = 0;
  page.on('request', (request) => {
    if (/predictor\.worker/iu.test(request.url())) workerRequestCount += 1;
  });
  await installTrajectoryPredictionTestHorizon(page, 3_600);
  await installTrajectoryPredictionTestPointCount(page, 32);
  try {
    const response = await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });
    assert.ok(response?.ok(), `production page returned ${String(response?.status())}`);
    await assertFreshMenu(page, false);
    assert.equal(workerRequestCount, 0, 'menu must not start the trajectory worker');
    await page.evaluate(() => {
      globalThis.requestAnimationFrame = () => 1;
    });

    await page.getByRole('button', { name: 'New Game' }).evaluate((button) => {
      button.click();
      button.click();
    });
    await waitForSpace(page, 1_000);
    assert.equal(
      (await readRuntimeState(page)).frameCount,
      0,
      'menu transition must not depend on a completed WebGL frame',
    );
    assert.equal(
      await dismissHardwareWarningIfPresent(page),
      true,
      'software fallback fixture did not render its mandatory warning',
    );
    const canonical = await page.evaluate(() => ({
      apoapsis:
        [...globalThis.document.querySelectorAll('#orbit-readout .hud-readout-row')]
          .find((row) => row.querySelector('dt')?.textContent?.trim() === 'Apoapsis')
          ?.querySelector('dd')
          ?.textContent?.trim() ?? '',
      canvasCount: globalThis.document.querySelectorAll('#space-canvas').length,
      hudCount: globalThis.document.querySelectorAll('#orbit-readout').length,
      dominantBody: globalThis.document.querySelector('#orbit-title')?.textContent?.trim() ?? '',
      periapsis:
        [...globalThis.document.querySelectorAll('#orbit-readout .hud-readout-row')]
          .find((row) => row.querySelector('dt')?.textContent?.trim() === 'Periapsis')
          ?.querySelector('dd')
          ?.textContent?.trim() ?? '',
      velocity:
        globalThis.document.querySelector('.state-vector-velocity dd')?.textContent?.trim() ?? '',
    }));
    assert.equal(canonical.canvasCount, 1);
    assert.equal(canonical.hudCount, 1);
    assert.equal(canonical.dominantBody, 'Earth');
    const apoapsisRadiusKm = Number.parseFloat(canonical.apoapsis.replaceAll(',', ''));
    const periapsisRadiusKm = Number.parseFloat(canonical.periapsis.replaceAll(',', ''));
    assert.ok(
      Math.abs(apoapsisRadiusKm - EARTH_MEAN_RADIUS_KM - 400) <= 0.02,
      `unexpected canonical apoapsis: ${canonical.apoapsis}`,
    );
    assert.ok(
      Math.abs(periapsisRadiusKm - EARTH_MEAN_RADIUS_KM - 400) <= 0.02,
      `unexpected canonical periapsis: ${canonical.periapsis}`,
    );
    const velocityKmS = Number.parseFloat(canonical.velocity);
    assert.ok(
      velocityKmS >= 37 && velocityKmS <= 39,
      `unexpected canonical LEO speed: ${canonical.velocity}`,
    );
    assert.equal(workerRequestCount, 1, 'repeated New Game must create one trajectory worker');
    await page.evaluate(() => {
      globalThis.window.dispatchEvent(new Event('resize'));
      globalThis.window.dispatchEvent(new Event('resize'));
      globalThis.window.dispatchEvent(new Event('scroll'));
      globalThis.window.dispatchEvent(new Event('scroll'));
      globalThis.window.dispatchEvent(
        new globalThis.PageTransitionEvent('pagehide', { persisted: true }),
      );
      globalThis.window.dispatchEvent(
        new globalThis.PageTransitionEvent('pagehide', { persisted: true }),
      );
    });
    assert.deepEqual((await readRuntimeState(page)).resources, ACTIVE_RUNTIME_RESOURCES);

    await page.locator('#session-settings').evaluate((details) => {
      details.open = true;
    });
    await page.locator('#target-selector').selectOption('mars');
    await page.locator('#session-save').click();
    assert.ok(
      await page.evaluate((key) => globalThis.localStorage.getItem(key) !== null, SAVE_STORAGE_KEY),
    );

    await page.reload({ waitUntil: 'domcontentloaded' });
    await assertFreshMenu(page, true);
    assert.equal(workerRequestCount, 1, 'reload menu must not start a trajectory worker');
    assert.equal(await dismissHardwareWarningIfPresent(page), true);
    await page.getByRole('button', { name: 'Continue' }).click();
    await waitForSpace(page);
    const continuedRuntime = await readRuntimeState(page);
    assert.equal(continuedRuntime.canvasCount, 1);
    assert.deepEqual(continuedRuntime.resources, ACTIVE_RUNTIME_RESOURCES);
    assert.equal(await page.locator('#target-selector').inputValue(), 'mars');
    assert.equal(await page.locator('#target-title').textContent(), 'Mars');
    assert.equal(workerRequestCount, 2, 'Continue must create one worker for the reloaded runtime');
    assert.deepEqual(browserErrors, []);
    return { canonical, workerRequestCount };
  } finally {
    await context.close();
  }
}

async function runInvalidSaveFlow(browser) {
  const context = await browser.newContext({ viewport: { width: 1_280, height: 720 } });
  const page = await context.newPage();
  const browserErrors = collectBrowserErrors(page);
  await disableUnrelatedTrajectoryPrediction(page);
  await page.addInitScript(({ key, value }) => globalThis.localStorage.setItem(key, value), {
    key: SAVE_STORAGE_KEY,
    value: '{"version":2,"corrupt":true}',
  });
  try {
    await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });
    await assertFreshMenu(page, false);
    assert.deepEqual(browserErrors, []);
  } finally {
    await context.close();
  }
}

async function runResponsiveAndReducedMotionFlow(browser) {
  const context = await browser.newContext({
    reducedMotion: 'reduce',
    viewport: { width: 360, height: 480 },
  });
  const page = await context.newPage();
  const browserErrors = collectBrowserErrors(page);
  await disableUnrelatedTrajectoryPrediction(page);
  try {
    await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });
    await assertFreshMenu(page, false);
    const layout = await page.locator('.main-menu').evaluate((menu) => {
      const bounds = menu.getBoundingClientRect();
      const primary = menu.querySelector('.main-menu-primary');
      if (!(primary instanceof globalThis.HTMLElement)) throw new Error('primary action missing');
      const motion = globalThis.getComputedStyle(primary);
      return {
        animationName: motion.animationName,
        bottom: bounds.bottom,
        reducedMotion: globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches,
        right: bounds.right,
        scrollWidth: globalThis.document.documentElement.scrollWidth,
        top: bounds.top,
        transitionDuration: motion.transitionDuration,
        viewportHeight: globalThis.innerHeight,
        viewportWidth: globalThis.innerWidth,
      };
    });
    assert.equal(layout.animationName, 'none');
    assert.equal(layout.transitionDuration, '0s');
    assert.equal(layout.reducedMotion, true);
    assert.ok(layout.top >= 0, `menu starts above compact viewport: ${JSON.stringify(layout)}`);
    assert.ok(
      layout.bottom <= layout.viewportHeight,
      `menu starts below compact viewport: ${JSON.stringify(layout)}`,
    );
    assert.ok(
      layout.right <= layout.viewportWidth,
      `menu overflows compact viewport: ${JSON.stringify(layout)}`,
    );
    assert.equal(layout.scrollWidth, layout.viewportWidth);

    await page.locator('#session-settings').evaluate((details) => {
      details.open = true;
    });
    const controls = page.locator(
      '.main-menu button, .main-menu summary, .main-menu select, .main-menu .session-import-label',
    );
    const controlCount = await controls.count();
    assert.ok(
      controlCount >= 10,
      `expected all compact menu controls, found ${String(controlCount)}`,
    );
    for (let index = 0; index < controlCount; index += 1) {
      const control = controls.nth(index);
      await control.scrollIntoViewIfNeeded();
      const bounds = await control.boundingBox();
      assert.ok(bounds !== null, `compact control ${String(index)} is not rendered`);
      assert.ok(bounds.y >= 0, `compact control ${String(index)} is above viewport`);
      assert.ok(
        bounds.y + bounds.height <= layout.viewportHeight,
        `compact control ${String(index)} is below viewport`,
      );
      const focusable = await control.evaluate((element) =>
        element.matches('button:not(:disabled), summary, select'),
      );
      if (focusable) {
        await control.focus();
        assert.equal(
          await control.evaluate((element) => element === globalThis.document.activeElement),
          true,
          `compact control ${String(index)} is not keyboard focusable`,
        );
      }
    }
    const compactScroll = await page.locator('.main-menu').evaluate((menu) => ({
      clientHeight: menu.clientHeight,
      overflowY: globalThis.getComputedStyle(menu).overflowY,
      scrollHeight: menu.scrollHeight,
      scrollTop: menu.scrollTop,
    }));
    assert.equal(compactScroll.overflowY, 'auto');
    assert.ok(
      compactScroll.scrollHeight > compactScroll.clientHeight,
      `compact menu did not expose a scroll range: ${JSON.stringify(compactScroll)}`,
    );
    assert.ok(compactScroll.scrollTop > 0, 'compact controls were not reachable by scrolling');
    const newGame = page.getByRole('button', { name: 'New Game' });
    await newGame.scrollIntoViewIfNeeded();
    await newGame.focus();
    await page.keyboard.press('Enter');
    await waitForSpace(page, 30_000, ACTIVE_RUNTIME_RESOURCES_WITHOUT_TRAJECTORY);
    await dismissHardwareWarningIfPresent(page);
    assert.deepEqual(browserErrors, []);
    return layout;
  } finally {
    await context.close();
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
    channel: 'chrome',
    headless: true,
    args: [
      '--enable-webgl',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
      '--use-angle=swiftshader',
    ],
  });
  const freshAndContinue = await runFreshAndContinueFlow(browser);
  await runInvalidSaveFlow(browser);
  const responsiveAndReducedMotion = await runResponsiveAndReducedMotionFlow(browser);
  process.stdout.write(
    `${JSON.stringify({ freshAndContinue, responsiveAndReducedMotion }, null, 2)}\n`,
  );
} finally {
  if (browser !== undefined) await browser.close();
  await server.close();
}
