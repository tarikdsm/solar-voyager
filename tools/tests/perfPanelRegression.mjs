import assert from 'node:assert/strict';

import { chromium } from 'playwright';
import { createServer } from 'vite';

const HOST = '127.0.0.1';
const PORT = 4184;
const PAGE_URL = `http://${HOST}:${String(PORT)}/solar-voyager/tests/render/perfPanel.html`;

function parseLeadingNumber(value) {
  const parsed = Number.parseFloat(value);
  assert.ok(Number.isFinite(parsed), `expected a leading number in "${value}"`);
  return parsed;
}

const server = await createServer({
  root: process.cwd(),
  base: '/solar-voyager/',
  logLevel: 'error',
  server: { host: HOST, port: PORT, strictPort: true },
});
let browser;

try {
  await server.listen();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1_280, height: 720 } });
  const browserErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => browserErrors.push(`pageerror: ${error.message}`));
  page.on('crash', () => browserErrors.push('page crash'));

  const response = await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });
  assert.ok(response?.ok(), `fixture page returned ${String(response?.status())}`);
  await page.waitForFunction(
    () => {
      const harness = globalThis.__perfPanelHarness;
      const panel = globalThis.document.querySelector('#perf-panel');
      return (
        harness !== undefined &&
        harness.snapshot().sampleCount === 120 &&
        panel instanceof globalThis.HTMLElement &&
        panel.dataset.sampleCount === '120'
      );
    },
    undefined,
    { timeout: 30_000 },
  );
  await page.waitForTimeout(300);

  const compact = await page.evaluate(() => {
    const panel = globalThis.document.querySelector('#perf-panel');
    const settings = globalThis.document.querySelector('#session-settings');
    const orbit = globalThis.document.querySelector('#orbit-readout');
    if (!(panel instanceof globalThis.HTMLElement)) throw new Error('perf panel missing');
    if (!(settings instanceof globalThis.HTMLElement)) throw new Error('settings missing');
    if (!(orbit instanceof globalThis.HTMLElement)) throw new Error('orbit readout missing');
    const panelRect = panel.getBoundingClientRect();
    const settingsRect = settings.getBoundingClientRect();
    const orbitRect = orbit.getBoundingClientRect();
    return {
      cost: panel.dataset.costMsPerFrame ?? '',
      expanded: globalThis.document
        .querySelector('#perf-panel-toggle')
        ?.getAttribute('aria-expanded'),
      fps: globalThis.document.querySelector('#perf-panel-fps')?.textContent ?? '',
      noOrbitOverlap: panelRect.bottom <= orbitRect.top || panelRect.right <= orbitRect.left,
      noSettingsOverlap:
        panelRect.bottom <= settingsRect.top || panelRect.right <= settingsRect.left,
      quality: globalThis.document.querySelector('#perf-panel-quality')?.textContent ?? '',
      resolution: globalThis.document.querySelector('#perf-panel-resolution')?.textContent ?? '',
      resolutionExpected: '1920×1080 @1.00',
      renderCount: globalThis.__perfPanelHarness.snapshot().renderCount,
      sampleCount: panel.dataset.sampleCount ?? '',
      sparklineInk: (() => {
        const canvas = globalThis.document.querySelector('#perf-panel-sparkline');
        if (!(canvas instanceof globalThis.HTMLCanvasElement)) return 0;
        const pixels = canvas.getContext('2d')?.getImageData(0, 0, canvas.width, canvas.height).data;
        if (pixels === undefined) return 0;
        let ink = 0;
        for (let index = 3; index < pixels.length; index += 4) {
          if ((pixels[index] ?? 0) > 0) ink += 1;
        }
        return ink;
      })(),
    };
  });
  assert.equal(compact.expanded, 'false');
  assert.match(compact.fps, /^\d+(?:\.\d)? FPS$/u);
  assert.equal(compact.quality, 'Q6/6');
  assert.equal(compact.resolution, compact.resolutionExpected);
  assert.equal(compact.sampleCount, '120');
  assert.ok(compact.sparklineInk > 0, 'canvas sparkline did not draw any pixels');
  assert.ok(parseLeadingNumber(compact.cost) < 0.2, `panel cost ${compact.cost} exceeds budget`);
  assert.equal(compact.noSettingsOverlap, true);
  assert.equal(compact.noOrbitOverlap, true);
  assert.equal(compact.renderCount, 1, 'leaf signal updates rerendered PerfPanel');

  await page.locator('#perf-panel-toggle').click();
  await page.waitForSelector('#perf-panel-details', { state: 'visible' });
  const expanded = await page.evaluate(() => ({
    context: globalThis.document.querySelector('#perf-panel-context')?.textContent ?? '',
    drawStats: globalThis.document.querySelector('#perf-panel-draw-stats')?.textContent ?? '',
    gpuName: globalThis.document.querySelector('#perf-panel-gpu-name')?.textContent ?? '',
    governor: globalThis.document.querySelector('#perf-panel-governor')?.textContent ?? '',
    low: globalThis.document.querySelector('#perf-panel-one-percent-low')?.textContent ?? '',
  }));
  assert.match(expanded.low, /^\d+(?:\.\d)? FPS$/u);
  assert.match(expanded.drawStats, /calls · .* triangles/u);
  assert.match(expanded.context, /^WebGL2 · (?:reversed|logarithmic) depth$/u);
  assert.ok(expanded.gpuName.length > 0);
  assert.equal(expanded.governor, 'Awaiting adaptive governor');

  await page.keyboard.press('F3');
  await page.waitForSelector('#perf-panel-details', { state: 'hidden' });
  await page.keyboard.press('F3');
  await page.waitForSelector('#perf-panel-details', { state: 'visible' });
  await page.evaluate(() =>
    globalThis.dispatchEvent(
      new globalThis.KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        code: 'F3',
        repeat: true,
      }),
    ),
  );
  await page.waitForTimeout(50);
  assert.equal(
    await page.locator('#perf-panel-toggle').getAttribute('aria-expanded'),
    'true',
    'repeated F3 keydown toggled the panel',
  );

  const independentFps = await page.evaluate(
    () =>
      new Promise((resolve) => {
        let firstTimestampMs = -1;
        let frameCount = 0;
        const sample = (timestampMs) => {
          if (firstTimestampMs < 0) firstTimestampMs = timestampMs;
          frameCount += 1;
          const elapsedMs = timestampMs - firstTimestampMs;
          if (elapsedMs >= 1_000) {
            const panelText =
              globalThis.document.querySelector('#perf-panel-fps')?.textContent ?? '';
            resolve({
              independentFps: ((frameCount - 1) * 1_000) / elapsedMs,
              panelFps: Number.parseFloat(panelText),
            });
            return;
          }
          globalThis.requestAnimationFrame(sample);
        };
        globalThis.requestAnimationFrame(sample);
      }),
  );
  const fpsTolerance = Math.max(8, independentFps.independentFps * 0.25);
  assert.ok(
    Math.abs(independentFps.panelFps - independentFps.independentFps) <= fpsTolerance,
    `panel ${independentFps.panelFps.toFixed(1)} FPS differs from independent meter ${independentFps.independentFps.toFixed(1)} FPS`,
  );

  await page.locator('#perf-panel-toggle').click();
  await page.waitForSelector('#perf-panel-details', { state: 'hidden' });
  await page.setViewportSize({ width: 1_024, height: 720 });
  await page.waitForTimeout(100);
  const intermediateLayout = await page.evaluate(() => {
    const panel = globalThis.document.querySelector('#perf-panel');
    const clock = globalThis.document.querySelector('#dual-clock');
    const warp = globalThis.document.querySelector('#warp-control');
    if (!(panel instanceof globalThis.HTMLElement)) throw new Error('perf panel missing');
    if (!(clock instanceof globalThis.HTMLElement)) throw new Error('dual clock missing');
    if (!(warp instanceof globalThis.HTMLElement)) throw new Error('warp control missing');
    const overlaps = (first, second) => {
      const a = first.getBoundingClientRect();
      const b = second.getBoundingClientRect();
      return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    };
    return {
      panelClockOverlap: overlaps(panel, clock),
      clockWarpOverlap: overlaps(clock, warp),
    };
  });
  assert.equal(intermediateLayout.panelClockOverlap, false);
  assert.equal(intermediateLayout.clockWarpOverlap, false);

  const stateVectorLayoutBefore = await page.evaluate(() =>
    globalThis.__perfPanelHarness.snapshot(),
  );
  await page.locator('#perf-panel-toggle').click();
  await page.waitForFunction(
    (before) => {
      const current = globalThis.__perfPanelHarness.snapshot();
      return (
        current.layoutRefreshCount > before.layoutRefreshCount &&
        current.stateVectorViewportTop > before.stateVectorViewportTop + 300
      );
    },
    stateVectorLayoutBefore,
  );
  const stateVectorLayoutAfter = await page.evaluate(() =>
    globalThis.__perfPanelHarness.snapshot(),
  );
  await page.locator('#perf-panel-toggle').click();
  await page.waitForSelector('#perf-panel-details', { state: 'hidden' });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  const mobile = await page.evaluate(() => {
    const panel = globalThis.document.querySelector('#perf-panel');
    if (!(panel instanceof globalThis.HTMLElement)) throw new Error('perf panel missing');
    const rect = panel.getBoundingClientRect();
    return {
      bodyScrollWidth: globalThis.document.body.scrollWidth,
      panelLeft: rect.left,
      panelRight: rect.right,
      viewportWidth: globalThis.innerWidth,
    };
  });
  assert.ok(mobile.bodyScrollWidth <= mobile.viewportWidth);
  assert.ok(mobile.panelLeft >= 0 && mobile.panelRight <= mobile.viewportWidth);
  assert.deepEqual(browserErrors, []);

  process.stdout.write(
    `${JSON.stringify({ compact, expanded, independentFps, intermediateLayout, mobile, stateVectorLayoutAfter, stateVectorLayoutBefore }, null, 2)}\n`,
  );
} finally {
  if (browser !== undefined) await browser.close();
  await server.close();
}
