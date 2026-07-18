import assert from 'node:assert/strict';

import { chromium } from 'playwright';
import { createServer } from 'vite';

const HOST = '127.0.0.1';
const PORT = 4179;
const PRODUCTION_URL = `http://${HOST}:${PORT}/solar-voyager/`;
const CONTROL_URL = `http://${HOST}:${PORT}/solar-voyager/tests/render/hardwareWarning.html`;

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
    headless: true,
    args: [
      '--enable-webgl',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
      '--use-angle=swiftshader',
    ],
  });
  const page = await browser.newPage({ viewport: { width: 1_280, height: 720 } });
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  await page.goto(PRODUCTION_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () =>
      globalThis.document.querySelector('#space-canvas[data-renderer-ready="true"]') !== null,
    undefined,
    { timeout: 60_000 },
  );
  const contextState = await page.locator('#space-canvas').evaluate((canvas) => ({
    depthStrategy: canvas.dataset.depthStrategy,
    rendererName: canvas.dataset.rendererName,
    softwareRasterizer: canvas.dataset.softwareRasterizer,
  }));
  assert.equal(contextState.softwareRasterizer, 'true');
  assert.match(contextState.rendererName, /SwiftShader/iu);
  assert.match(contextState.depthStrategy, /^(?:reversed|logarithmic)$/u);

  const warning = page.locator('#hardware-acceleration-warning');
  await warning.waitFor({ state: 'visible' });
  await expectText(warning, 'Hardware acceleration is disabled');
  await expectText(warning, 'Chrome: Settings');
  await expectText(warning, 'Firefox:');
  await page.keyboard.press('Escape');
  assert.equal(await warning.isVisible(), true, 'Escape dismissed the mandatory warning');
  await page.mouse.click(1_200, 700);
  assert.equal(await warning.isVisible(), true, 'outside click dismissed the mandatory warning');
  await warning.getByRole('button', { name: 'I understand' }).click();
  await warning.waitFor({ state: 'detached' });

  const controlPage = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await controlPage.goto(CONTROL_URL, { waitUntil: 'domcontentloaded' });
  await controlPage.waitForSelector('#warning-root[data-policy-ready="true"]', {
    state: 'attached',
  });
  const hardwareState = await controlPage.locator('#warning-root').evaluate((root) => ({
    contextAttempts: root.dataset.contextAttempts,
    gpuTimerQueryAvailable: root.dataset.gpuTimerQueryAvailable,
    rendererName: root.dataset.rendererName,
    usedPerformanceCaveatFallback: root.dataset.usedPerformanceCaveatFallback,
    warningRequired: root.dataset.warningRequired,
  }));
  assert.deepEqual(hardwareState, {
    contextAttempts: '1',
    gpuTimerQueryAvailable: 'true',
    rendererName: 'ANGLE (Intel Iris Xe Graphics)',
    usedPerformanceCaveatFallback: 'false',
    warningRequired: 'false',
  });
  assert.equal(
    await controlPage.locator('#hardware-acceleration-warning').count(),
    0,
    'hardware control path rendered a warning',
  );

  assert.deepEqual(pageErrors, []);
  assert.deepEqual(consoleErrors, []);
  process.stdout.write(`${JSON.stringify(contextState, null, 2)}\n`);
} finally {
  if (browser !== undefined) await browser.close();
  await server.close();
}

async function expectText(locator, text) {
  assert.match(await locator.innerText(), new RegExp(text, 'u'));
}
