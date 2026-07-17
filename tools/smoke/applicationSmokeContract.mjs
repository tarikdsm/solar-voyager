import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import { preview } from 'vite';

import { assertPortAvailable } from '../bench/scaffoldBenchUtils.mjs';

const HOST = '127.0.0.1';
const PORT = 4175;
const PAGE_URL = `http://${HOST}:${String(PORT)}/solar-voyager/`;
const RUNTIME_ERROR_MARKER = 'SOLAR_VOYAGER_INJECTED_SMOKE_RUNTIME_ERROR';
const RUNTIME_ERROR_FIXTURE = fileURLToPath(
  new URL('../../tests/smoke/runtimeError.fixture.js', import.meta.url),
);
const FRAMEBUFFER_ERROR_MARKER = 'SOLAR_VOYAGER_INJECTED_FRAMEBUFFER_RUNTIME_ERROR';
const FRAMEBUFFER_ERROR_FIXTURE = fileURLToPath(
  new URL('../../tests/smoke/framebufferRuntimeError.fixture.js', import.meta.url),
);

function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

function assertNoBrowserErrors(browserErrors) {
  if (browserErrors.length > 0) {
    throw new Error(`browser errors detected: ${browserErrors.join(' | ')}`);
  }
}

async function probeCanvasPixels(page) {
  const metrics = await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        globalThis.requestAnimationFrame(() => {
          const canvas = globalThis.document.querySelector('#space-canvas');
          if (!(canvas instanceof globalThis.HTMLCanvasElement)) {
            reject(new Error('space canvas is not an HTMLCanvasElement'));
            return;
          }
          const context = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
          if (context === null) {
            reject(new Error('space canvas has no WebGL context'));
            return;
          }
          const width = context.drawingBufferWidth;
          const height = context.drawingBufferHeight;
          const pixels = new globalThis.Uint8Array(width * height * 4);
          context.readPixels(0, 0, width, height, context.RGBA, context.UNSIGNED_BYTE, pixels);
          let minimumLuminance = 255;
          let maximumLuminance = 0;
          let litPixels = 0;
          for (let offset = 0; offset < pixels.length; offset += 4) {
            const luminance =
              0.2126 * (pixels[offset] ?? 0) +
              0.7152 * (pixels[offset + 1] ?? 0) +
              0.0722 * (pixels[offset + 2] ?? 0);
            minimumLuminance = Math.min(minimumLuminance, luminance);
            maximumLuminance = Math.max(maximumLuminance, luminance);
            if (luminance >= 16) litPixels += 1;
          }
          resolve({ height, maximumLuminance, minimumLuminance, litPixels, width });
        });
      }),
  );
  const luminanceRange = metrics.maximumLuminance - metrics.minimumLuminance;
  assert.ok(luminanceRange >= 12, `space canvas is blank: luminance range ${luminanceRange}`);
  assert.ok(
    metrics.litPixels >= 2,
    `space canvas has too few lit pixels: ${String(metrics.litPixels)}`,
  );
  return { height: metrics.height, luminanceRange, litPixels: metrics.litPixels, width: metrics.width };
}

async function runProbe(browser, fixturePath = null) {
  const page = await browser.newPage({ viewport: { width: 1_280, height: 720 } });
  const browserErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => browserErrors.push(`pageerror: ${error.message}`));
  page.on('crash', () => browserErrors.push('page crash'));
  if (fixturePath !== null) await page.addInitScript({ path: fixturePath });

  try {
    const response = await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });
    assert.ok(response?.ok(), `production page returned ${String(response?.status())}`);
    await page.waitForSelector(
      '#space-canvas[data-renderer-ready="true"][data-camera-ready="true"]',
      { state: 'attached', timeout: 30_000 },
    );
    await page.waitForSelector('.app-overlay', { state: 'attached', timeout: 30_000 });
    await page.waitForTimeout(250);

    assertNoBrowserErrors(browserErrors);

    const hud = await page.evaluate(() => ({
      appOverlay: globalThis.document.querySelectorAll('.app-overlay').length,
      orbitReadout: globalThis.document.querySelectorAll('#orbit-readout').length,
      sessionSettings: globalThis.document.querySelectorAll('#session-settings').length,
      simulationClocks: globalThis.document.querySelectorAll('[aria-label="Simulation clocks"]')
        .length,
      timeWarp: globalThis.document.querySelectorAll('[aria-label="Time warp control"]').length,
    }));
    assert.deepEqual(hud, {
      appOverlay: 1,
      orbitReadout: 1,
      sessionSettings: 1,
      simulationClocks: 1,
      timeWarp: 1,
    });
    const canvas = await probeCanvasPixels(page);
    await page.waitForTimeout(0);
    assertNoBrowserErrors(browserErrors);
    return { canvas, hud };
  } finally {
    await page.close();
  }
}

async function expectRuntimeFixtureFailure(browser, fixturePath, marker) {
  try {
    await runProbe(browser, fixturePath);
  } catch (error) {
    const message = describeError(error);
    assert.match(message, new RegExp(marker, 'u'));
    return message;
  }
  throw new Error(`${marker} fixture did not make the probe fail`);
}

export async function runApplicationSmokeContract({ delayedFixtureOnly = false, fixtureOnly = false } = {}) {
  await assertPortAvailable(PORT, HOST);
  const server = await preview({
    root: process.cwd(),
    base: '/solar-voyager/',
    logLevel: 'error',
    preview: { host: HOST, port: PORT, strictPort: true },
  });
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    if (fixtureOnly) return await runProbe(browser, RUNTIME_ERROR_FIXTURE);
    if (delayedFixtureOnly) return await runProbe(browser, FRAMEBUFFER_ERROR_FIXTURE);
    const rejectedFixture = await expectRuntimeFixtureFailure(
      browser,
      RUNTIME_ERROR_FIXTURE,
      RUNTIME_ERROR_MARKER,
    );
    const rejectedFramebufferFixture = await expectRuntimeFixtureFailure(
      browser,
      FRAMEBUFFER_ERROR_FIXTURE,
      FRAMEBUFFER_ERROR_MARKER,
    );
    const production = await runProbe(browser);
    return { production, rejectedFixture, rejectedFramebufferFixture };
  } finally {
    if (browser !== undefined) await browser.close();
    await server.close();
  }
}
