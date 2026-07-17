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
      budgetY: globalThis.document
        .querySelector('#perf-panel-budget-line')
        ?.getAttribute('y1'),
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
    };
  });
  assert.equal(compact.expanded, 'false');
  assert.match(compact.fps, /^\d+(?:\.\d)? FPS$/u);
  assert.equal(compact.quality, 'Q6/6');
  assert.equal(compact.resolution, compact.resolutionExpected);
  assert.equal(compact.sampleCount, '120');
  assert.ok(Math.abs(parseLeadingNumber(compact.budgetY ?? '') - 21.376) < 0.01);
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

  process.stdout.write(`${JSON.stringify({ compact, expanded, independentFps, mobile }, null, 2)}\n`);
} finally {
  if (browser !== undefined) await browser.close();
  await server.close();
}
