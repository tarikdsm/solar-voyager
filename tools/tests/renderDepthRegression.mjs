import assert from 'node:assert/strict';

import { chromium } from 'playwright';
import { createServer } from 'vite';

const HOST = '127.0.0.1';
const PORT = 4176;
const FIXTURE_URL = `http://${HOST}:${PORT}/solar-voyager/tests/render/depthRegression.html`;

async function capture(page, suffix = '') {
  await page.goto(`${FIXTURE_URL}${suffix}`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => globalThis.__depthRegressionResult !== undefined);
  return page.evaluate(() => globalThis.__depthRegressionResult);
}

function assertVisibleAndStable(result) {
  assert.equal(result.glError, 0, `${result.mode} emitted a WebGL error`);
  assert.equal(result.cases.length, 2);

  for (const depthCase of result.cases) {
    assert.equal(depthCase.centerFront, true, `${depthCase.name}: foreground lost depth test`);
    assert.ok(depthCase.frontPixels > 100, `${depthCase.name}: foreground is not visible`);
    assert.ok(depthCase.rearPixels > 100, `${depthCase.name}: depth witness is not visible`);
    assert.ok(depthCase.backgroundPixels > 100, `${depthCase.name}: framing is invalid`);
    assert.equal(depthCase.stablePixels, true, `${depthCase.name}: consecutive frames jitter`);
  }
}

const server = await createServer({
  root: process.cwd(),
  logLevel: 'error',
  server: { host: HOST, port: PORT, strictPort: true },
});
let browser;

try {
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    args: ['--enable-webgl', '--ignore-gpu-blocklist'],
  });
  const page = await browser.newPage({ viewport: { width: 256, height: 256 } });
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });

  let logarithmic;
  let reversed;
  let standardControl;
  try {
    logarithmic = await capture(page, '?depth=logarithmic');
    reversed = await capture(page, '?depth=reversed');
    standardControl = await capture(page, '?standard-control');
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ pageErrors, consoleErrors }, null, 2)}\n`);
    throw error;
  }

  process.stdout.write(`${JSON.stringify({ logarithmic, reversed, standardControl }, null, 2)}\n`);
  assertVisibleAndStable(logarithmic);
  assertVisibleAndStable(reversed);
  assert.equal(reversed.mode, 'reversed');
  assert.equal(logarithmic.mode, 'logarithmic');
  assert.ok(
    standardControl.cases.some((depthCase) => !depthCase.centerFront),
    'standard-depth control unexpectedly passed; regression is not sensitive to depth precision',
  );
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(consoleErrors, []);
} finally {
  if (browser !== undefined) {
    await browser.close();
  }
  await server.close();
}
