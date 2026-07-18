import assert from 'node:assert/strict';

import { chromium } from 'playwright';
import { createServer } from 'vite';

import { installTrajectoryPredictionTestHorizon } from './trajectoryPredictionTestIsolation.mjs';

const HOST = '127.0.0.1';
const PORT = 4190;
const FIXTURE_URL = `http://${HOST}:${PORT}/solar-voyager/tests/render/trajectoryOverlay.html`;
const PRODUCTION_URL = `http://${HOST}:${PORT}/solar-voyager/`;

const server = await createServer({
  root: process.cwd(),
  base: '/solar-voyager/',
  logLevel: 'error',
  server: { host: HOST, port: PORT, strictPort: true },
});
let browser;

try {
  await server.listen();
  browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--enable-webgl', '--ignore-gpu-blocklist'],
  });
  const page = await browser.newPage({ viewport: { width: 800, height: 450 } });
  const browserErrors = [];
  page.on('pageerror', (error) => browserErrors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(`console: ${message.text()}`);
  });
  await page.goto(FIXTURE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => globalThis.__trajectoryOverlayHarness !== undefined, undefined, {
    timeout: 5_000,
  });

  const wide = await page.evaluate(() => globalThis.__trajectoryOverlayHarness.snapshot());
  const zoomed = await page.evaluate(() => globalThis.__trajectoryOverlayHarness.setFov(20));
  for (const [label, snapshot] of [
    ['wide', wide],
    ['zoomed', zoomed],
  ]) {
    assert.equal(snapshot.markerCount, 3, `${label} marker count`);
    assert.equal(snapshot.segmentCount, 3, `${label} segment count`);
    assert.ok(snapshot.drawCalls <= 2, `${label} prediction draw calls: ${snapshot.drawCalls}`);
    assert.ok(
      snapshot.maximumAlignmentCssPx <= 0.001,
      `${label} marker alignment ${snapshot.maximumAlignmentCssPx} px`,
    );
  }
  assert.deepEqual(browserErrors, []);
  await page.close();

  const productionPage = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await installTrajectoryPredictionTestHorizon(productionPage, 21_600);
  const productionErrors = [];
  productionPage.on('pageerror', (error) => productionErrors.push(`pageerror: ${error.message}`));
  productionPage.on('console', (message) => {
    if (message.type() === 'error') productionErrors.push(`console: ${message.text()}`);
  });
  const workerResponse = productionPage.waitForResponse(
    (response) => /predictor\.worker/iu.test(response.url()),
    { timeout: 30_000 },
  );
  await productionPage.goto(PRODUCTION_URL, { waitUntil: 'domcontentloaded' });
  await productionPage.waitForFunction(
    () =>
      globalThis.document.querySelector(
        '#space-canvas[data-camera-ready="true"][data-trajectory-ready="pending"]',
      ) !== null,
    undefined,
    { timeout: 60_000 },
  );
  const loadedWorkerResponse = await workerResponse;
  assert.ok(loadedWorkerResponse.ok(), `worker response ${loadedWorkerResponse.status()}`);
  await productionPage.waitForFunction(
    () => {
      const state = globalThis.document.querySelector('#space-canvas')?.dataset.trajectoryReady;
      return state === 'true' || state === 'error';
    },
    undefined,
    { timeout: 90_000 },
  );
  const productionState = await productionPage.evaluate(() => ({
    appHtml: globalThis.document.querySelector('#app')?.innerHTML.slice(0, 1_000) ?? '',
    bodyText: globalThis.document.body.textContent?.slice(0, 500) ?? '',
    selectorCount: globalThis.document.querySelectorAll('#target-selector').length,
    trajectoryReady:
      globalThis.document.querySelector('#space-canvas')?.dataset.trajectoryReady ?? '',
    url: globalThis.location.href,
  }));
  assert.equal(
    productionState.selectorCount,
    1,
    `production target selector missing: ${JSON.stringify({ productionErrors, productionState })}`,
  );
  assert.equal(
    productionState.trajectoryReady,
    'true',
    `production prediction did not complete: ${JSON.stringify({ productionErrors, productionState })}`,
  );
  const nextApproach = await productionPage.evaluate(() => {
    const labels = globalThis.document.querySelectorAll('#target-panel dt');
    for (const label of labels) {
      if (label.textContent?.trim() === 'Next approach') {
        return label.nextElementSibling?.textContent?.trim() ?? null;
      }
    }
    return null;
  });
  assert.notEqual(nextApproach, null, 'production Next approach readout is missing');
  assert.equal(nextApproach, '—');
  assert.deepEqual(productionErrors, []);
  const productionWorkerUrl = loadedWorkerResponse.url();
  await productionPage.goto('about:blank', { waitUntil: 'load' });
  await productionPage.close();

  process.stdout.write(
    `${JSON.stringify(
      {
        productionNextApproach: nextApproach,
        productionWorkerUrl,
        wide,
        zoomed,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  if (browser !== undefined) await browser.close();
  await server.close();
}
