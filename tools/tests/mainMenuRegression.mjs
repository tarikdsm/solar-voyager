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
      runtimeActivationCount: canvas.dataset.runtimeActivationCount ?? null,
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
    runtimeActivationCount: null,
  });
  const newGame = page.getByRole('button', { name: 'New Game' });
  const continueButton = page.getByRole('button', { name: 'Continue' });
  assert.equal(await newGame.evaluate((element) => element === globalThis.document.activeElement), true);
  assert.equal(await continueButton.isEnabled(), expectedContinueEnabled);
}

async function waitForSpace(page) {
  await page.waitForSelector('#orbit-readout', { state: 'visible', timeout: 30_000 });
  await page.waitForFunction(
    () => {
      const canvas = globalThis.document.querySelector('#space-canvas');
      return (
        canvas instanceof globalThis.HTMLCanvasElement &&
        canvas.dataset.cameraReady === 'true' &&
        (canvas.solarVoyagerTelemetry?.snapshot.frameCount ?? 0) > 0
      );
    },
    undefined,
    { timeout: 30_000 },
  );
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

    await page.getByRole('button', { name: 'New Game' }).evaluate((button) => {
      button.click();
      button.click();
    });
    await waitForSpace(page);
    const canonical = await page.evaluate(() => ({
      canvasCount: globalThis.document.querySelectorAll('#space-canvas').length,
      hudCount: globalThis.document.querySelectorAll('#orbit-readout').length,
      dominantBody: globalThis.document.querySelector('#orbit-title')?.textContent?.trim() ?? '',
      velocity:
        globalThis.document.querySelector('.state-vector-velocity dd')?.textContent?.trim() ?? '',
    }));
    assert.equal(canonical.canvasCount, 1);
    assert.equal(canonical.hudCount, 1);
    assert.equal(canonical.dominantBody, 'Earth');
    const velocityKmS = Number.parseFloat(canonical.velocity);
    assert.ok(velocityKmS >= 37 && velocityKmS <= 39, `unexpected canonical LEO speed: ${canonical.velocity}`);
    assert.equal(workerRequestCount, 1, 'repeated New Game must create one trajectory worker');
    assert.equal((await readRuntimeState(page)).runtimeActivationCount, '1');

    await page.locator('#session-settings').evaluate((details) => {
      details.open = true;
    });
    await page.locator('#session-save').click();
    assert.ok(await page.evaluate((key) => globalThis.localStorage.getItem(key) !== null, SAVE_STORAGE_KEY));

    await page.reload({ waitUntil: 'domcontentloaded' });
    await assertFreshMenu(page, true);
    assert.equal(workerRequestCount, 1, 'reload menu must not start a trajectory worker');
    await page.getByRole('button', { name: 'Continue' }).click();
    await waitForSpace(page);
    assert.equal((await readRuntimeState(page)).canvasCount, 1);
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
  await page.addInitScript(
    ({ key, value }) => globalThis.localStorage.setItem(key, value),
    { key: SAVE_STORAGE_KEY, value: '{"version":2,"corrupt":true}' },
  );
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
    viewport: { width: 360, height: 640 },
  });
  const page = await context.newPage();
  const browserErrors = collectBrowserErrors(page);
  await disableUnrelatedTrajectoryPrediction(page);
  try {
    await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });
    await assertFreshMenu(page, false);
    const layout = await page.locator('.main-menu').evaluate((menu) => ({
      reducedMotion: globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches,
      right: menu.getBoundingClientRect().right,
      scrollWidth: globalThis.document.documentElement.scrollWidth,
      viewportWidth: globalThis.innerWidth,
    }));
    assert.equal(layout.reducedMotion, true);
    assert.ok(layout.right <= layout.viewportWidth, `menu overflows compact viewport: ${JSON.stringify(layout)}`);
    assert.equal(layout.scrollWidth, layout.viewportWidth);
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
  browser = await chromium.launch({ channel: 'chrome', headless: true });
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
