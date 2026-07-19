import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import { preview } from 'vite';

import { assertPortAvailable } from '../bench/scaffoldBenchUtils.mjs';
import { disableUnrelatedTrajectoryPrediction } from '../tests/trajectoryPredictionTestIsolation.mjs';

const HOST = '127.0.0.1';
const PORT = 4175;
const PAGE_URL = `http://${HOST}:${String(PORT)}/solar-voyager/?autostart=1`;
const RUNTIME_ERROR_MARKER = 'SOLAR_VOYAGER_INJECTED_SMOKE_RUNTIME_ERROR';
const RUNTIME_ERROR_FIXTURE = fileURLToPath(
  new URL('../../tests/smoke/runtimeError.fixture.js', import.meta.url),
);
const FRAMEBUFFER_ERROR_MARKER = 'SOLAR_VOYAGER_INJECTED_FRAMEBUFFER_RUNTIME_ERROR';
const FRAMEBUFFER_ERROR_FIXTURE = fileURLToPath(
  new URL('../../tests/smoke/framebufferRuntimeError.fixture.js', import.meta.url),
);

function assertNoBrowserErrors(browserErrors) {
  if (browserErrors.length > 0) {
    throw new Error(`browser errors detected: ${browserErrors.join(' | ')}`);
  }
}

async function probeProductionStateVector(page) {
  const labels = await page.evaluate(() => ({
    gamma: globalThis.document.querySelector('#state-vector-gamma')?.textContent ?? '',
    speedFraction:
      globalThis.document.querySelector('#state-vector-speed-fraction')?.textContent ?? '',
    velocity:
      globalThis.document.querySelector('.state-vector-velocity dd')?.textContent ?? '',
  }));
  const velocityKmS = Number.parseFloat(labels.velocity);
  assert.ok(
    velocityKmS >= 37 && velocityKmS <= 39,
    `live CM-relative LEO velocity is unexpected: ${labels.velocity}`,
  );
  assert.match(labels.gamma, /^\u03b3 1\.\d{6}$/u);
  assert.match(labels.speedFraction, /^0\.012\d% c$/u);

  const orientation = await page.evaluate(async () => {
    const button = globalThis.document.querySelector('#state-vector-orientation');
    if (!(button instanceof globalThis.HTMLButtonElement)) throw new Error('orientation missing');
    const initialPressed = button.getAttribute('aria-pressed');
    button.click();
    await Promise.resolve();
    await Promise.resolve();
    const pinnedLabel = button.textContent?.trim() ?? '';
    const pinnedPressed = button.getAttribute('aria-pressed');
    button.click();
    await Promise.resolve();
    await Promise.resolve();
    return {
      initialPressed,
      pinnedLabel,
      pinnedPressed,
      restoredPressed: button.getAttribute('aria-pressed'),
    };
  });
  assert.deepEqual(orientation, {
    initialPressed: 'false',
    pinnedLabel: 'Ecliptic axes',
    pinnedPressed: 'true',
    restoredPressed: 'false',
  });

  const pixels = await page.evaluate(() => {
    const canvas = globalThis.document.querySelector('#space-canvas');
    const viewport = globalThis.document.querySelector('#state-vector-viewport');
    if (!(canvas instanceof globalThis.HTMLCanvasElement)) throw new Error('canvas missing');
    if (!(viewport instanceof globalThis.HTMLElement)) throw new Error('viewport missing');
    const context = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    if (context === null) throw new Error('WebGL context missing');
    const canvasRect = canvas.getBoundingClientRect();
    const viewportRect = viewport.getBoundingClientRect();
    const scaleX = canvas.width / canvasRect.width;
    const scaleY = canvas.height / canvasRect.height;
    const x = Math.max(0, Math.floor((viewportRect.left - canvasRect.left) * scaleX));
    const y = Math.max(0, Math.floor((canvasRect.bottom - viewportRect.bottom) * scaleY));
    const width = Math.min(canvas.width - x, Math.ceil(viewportRect.width * scaleX));
    const height = Math.min(canvas.height - y, Math.ceil(viewportRect.height * scaleY));
    const rgba = new globalThis.Uint8Array(width * height * 4);
    context.readPixels(x, y, width, height, context.RGBA, context.UNSIGNED_BYTE, rgba);
    let chromaticPixels = 0;
    let darkPixels = 0;
    for (let offset = 0; offset < rgba.length; offset += 4) {
      const red = rgba[offset] ?? 0;
      const green = rgba[offset + 1] ?? 0;
      const blue = rgba[offset + 2] ?? 0;
      const maximum = Math.max(red, green, blue);
      const minimum = Math.min(red, green, blue);
      if (red * 0.2126 + green * 0.7152 + blue * 0.0722 < 45) darkPixels += 1;
      if (maximum > 65 && maximum - minimum > 28) chromaticPixels += 1;
    }
    return { chromaticPixels, darkPixels, height, width };
  });
  assert.ok(pixels.width >= 140 && pixels.height >= 140, `widget is clipped: ${JSON.stringify(pixels)}`);
  assert.ok(pixels.darkPixels > pixels.width * pixels.height * 0.85, 'widget backdrop is missing');
  assert.ok(pixels.chromaticPixels >= 24, 'widget vectors are not visible');
  return { labels, pixels };
}

async function probeCanvasPixels(page) {
  await page.waitForFunction(
    () => {
      const canvas = globalThis.document.querySelector('#space-canvas');
      return (
        canvas instanceof globalThis.HTMLCanvasElement &&
        canvas.solarVoyagerTelemetry?.frameSampleCount > 0
      );
    },
    undefined,
    { timeout: 60_000 },
  );
  const metrics = await page.evaluate(() => {
    const canvas = globalThis.document.querySelector('#space-canvas');
    if (!(canvas instanceof globalThis.HTMLCanvasElement)) {
      throw new Error('space canvas is not an HTMLCanvasElement');
    }
    const context = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    if (context === null) throw new Error('space canvas has no WebGL context');
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
    return { height, maximumLuminance, minimumLuminance, litPixels, width };
  });
  const luminanceRange = metrics.maximumLuminance - metrics.minimumLuminance;
  assert.ok(luminanceRange >= 12, `space canvas is blank: luminance range ${luminanceRange}`);
  assert.ok(
    metrics.litPixels >= 2,
    `space canvas has too few lit pixels: ${String(metrics.litPixels)}`,
  );
  return { height: metrics.height, luminanceRange, litPixels: metrics.litPixels, width: metrics.width };
}

async function runProbe(browser, fixturePath = null, probeStateVector = false) {
  const page = await browser.newPage({ viewport: { width: 1_280, height: 720 } });
  const browserErrors = [];
  let trajectoryWorkerRequestCount = 0;
  page.on('request', (request) => {
    if (/predictor\.worker/iu.test(request.url())) trajectoryWorkerRequestCount += 1;
  });
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => browserErrors.push(`pageerror: ${error.message}`));
  page.on('crash', () => browserErrors.push('page crash'));
  await disableUnrelatedTrajectoryPrediction(page);
  if (fixturePath !== null) await page.addInitScript({ path: fixturePath });

  try {
    const response = await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });
    assert.ok(response?.ok(), `production page returned ${String(response?.status())}`);
    await page.waitForFunction(
      () =>
        globalThis.document.querySelector(
          '#space-canvas[data-renderer-ready="true"][data-camera-ready="true"]',
        ) !== null && globalThis.document.querySelector('.app-overlay') !== null,
      undefined,
      { timeout: 30_000 },
    );
    await page.waitForTimeout(250);

    assertNoBrowserErrors(browserErrors);

    const hud = await page.evaluate(() => ({
      appOverlay: globalThis.document.querySelectorAll('.app-overlay').length,
      orbitReadout: globalThis.document.querySelectorAll('#orbit-readout').length,
      perfPanel: globalThis.document.querySelectorAll('#perf-panel').length,
      sessionSettings: globalThis.document.querySelectorAll('#session-settings').length,
      simulationClocks: globalThis.document.querySelectorAll('[aria-label="Simulation clocks"]')
        .length,
      timeWarp: globalThis.document.querySelectorAll('[aria-label="Time warp control"]').length,
    }));
    assert.deepEqual(hud, {
      appOverlay: 1,
      orbitReadout: 1,
      perfPanel: 1,
      sessionSettings: 1,
      simulationClocks: 1,
      timeWarp: 1,
    });
    const canvas = await probeCanvasPixels(page);
    const stateVector = probeStateVector ? await probeProductionStateVector(page) : null;
    await page.waitForTimeout(0);
    assertNoBrowserErrors(browserErrors);
    assert.equal(
      trajectoryWorkerRequestCount,
      0,
      'application smoke must not start the unrelated long-horizon trajectory worker',
    );
    return { canvas, hud, stateVector };
  } finally {
    await page.close();
  }
}

async function expectRuntimeFixtureFailure(browser, fixturePath, marker, triggerReadPixels = false) {
  const page = await browser.newPage({ viewport: { width: 1_280, height: 720 } });
  await disableUnrelatedTrajectoryPrediction(page);
  let timeout;
  const failure = new Promise((resolve, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`${marker} fixture did not report its injected error`)),
      60_000,
    );
    const inspect = (message) => {
      if (message.includes(marker)) resolve(message);
    };
    page.on('pageerror', (error) => inspect(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') inspect(`console: ${message.text()}`);
    });
    page.on('crash', () => reject(new Error(`${marker} fixture page crashed`)));
  });
  await page.addInitScript({ path: fixturePath });
  try {
    const response = await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });
    assert.ok(response?.ok(), `fixture page returned ${String(response?.status())}`);
    if (triggerReadPixels) {
      await page.waitForFunction(
        () =>
          globalThis.document.querySelector('#space-canvas[data-renderer-ready="true"]') !== null,
        undefined,
        { timeout: 30_000 },
      );
      await page.evaluate(() => {
        const canvas = globalThis.document.querySelector('#space-canvas');
        if (!(canvas instanceof globalThis.HTMLCanvasElement)) throw new Error('canvas missing');
        const context = canvas.getContext('webgl2');
        if (context === null) throw new Error('WebGL2 context missing');
        context.readPixels(
          0,
          0,
          1,
          1,
          context.RGBA,
          context.UNSIGNED_BYTE,
          new globalThis.Uint8Array(4),
        );
      });
    }
    const message = await failure;
    assert.match(message, new RegExp(marker, 'u'));
    return message;
  } finally {
    clearTimeout(timeout);
    await page.close();
  }
}

export async function runApplicationSmokeContract({
  delayedFixtureOnly = false,
  fixtureOnly = false,
  productionOnly = false,
} = {}) {
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
    if (fixtureOnly) return await runProbe(browser, RUNTIME_ERROR_FIXTURE);
    if (delayedFixtureOnly) return await runProbe(browser, FRAMEBUFFER_ERROR_FIXTURE);
    if (productionOnly) return await runProbe(browser, null, true);
    const rejectedFixture = await expectRuntimeFixtureFailure(
      browser,
      RUNTIME_ERROR_FIXTURE,
      RUNTIME_ERROR_MARKER,
    );
    const rejectedFramebufferFixture = await expectRuntimeFixtureFailure(
      browser,
      FRAMEBUFFER_ERROR_FIXTURE,
      FRAMEBUFFER_ERROR_MARKER,
      true,
    );
    const production = await runProbe(browser, null, true);
    return { production, rejectedFixture, rejectedFramebufferFixture };
  } finally {
    if (browser !== undefined) await browser.close();
    await server.close();
  }
}
