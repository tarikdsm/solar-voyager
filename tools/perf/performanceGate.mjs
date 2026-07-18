import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import { preview } from 'vite';

import { assertPortAvailable } from '../bench/scaffoldBenchUtils.mjs';
import { installHighQualitySetting } from './browserSettings.mjs';
import { measureBundleSizes } from './bundleMeasurement.mjs';
import {
  parsePerformanceGolden,
  validateBundleSizes,
  validateHeapGrowth,
  validateWorkload,
} from './performanceGateUtils.mjs';

const HOST = '127.0.0.1';
const PORT = 4176;
const PAGE_URL = `http://${HOST}:${String(PORT)}/solar-voyager/`;
const TELEMETRY_PROPERTY = 'solarVoyagerTelemetry';
const GOLDEN_PATH = fileURLToPath(new URL('./performance-golden.json', import.meta.url));
const ALLOCATION_BYTES_PER_FRAME = 64 * 1024;
const HEAP_SETTLE_MS = 60_000;
const FIXTURE_SETTLE_MS = 1_000;
const STABLE_SNAPSHOT_COUNT = 4;
const PRODUCTION_ONLY = process.argv.includes('--production-only');

function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

async function readGolden() {
  return parsePerformanceGolden(JSON.parse(await readFile(GOLDEN_PATH, 'utf8')));
}

function addBrowserErrorListeners(page, browserErrors) {
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => browserErrors.push(`pageerror: ${error.message}`));
  page.on('crash', () => browserErrors.push('page crash'));
}

async function installCooperativeFrameLoop(page, allocationFixture) {
  await page.addInitScript(
    ({ allocationBytesPerFrame }) => {
      const retained = [];
      const requestFrame = globalThis.requestAnimationFrame.bind(globalThis);
      let pendingCallback = null;
      let pendingTimestamp = 0;

      function deliverFrame() {
        const callback = pendingCallback;
        pendingCallback = null;
        if (allocationBytesPerFrame > 0) {
          retained.push(new Uint8Array(allocationBytesPerFrame));
        }
        callback?.(pendingTimestamp);
      }

      function queueFrame(timestamp) {
        pendingTimestamp = timestamp;
        globalThis.setTimeout(deliverFrame, 0);
      }

      globalThis.requestAnimationFrame = (callback) => {
        if (pendingCallback !== null) {
          throw new Error('Performance gate supports one active animation-frame callback.');
        }
        pendingCallback = callback;
        return requestFrame(queueFrame);
      };
      if (allocationBytesPerFrame > 0) {
        Object.defineProperty(globalThis, '__performanceAllocationFixture', {
          value: retained,
        });
      }
    },
    { allocationBytesPerFrame: allocationFixture ? ALLOCATION_BYTES_PER_FRAME : 0 },
  );
}

async function exposeGc(page) {
  const available = await page.evaluate(() => typeof globalThis.gc === 'function');
  if (!available) throw new Error('Chromium did not expose gc().');
}

async function forceGc(page) {
  return page.evaluate(() => {
    globalThis.gc();
    globalThis.gc();
    return 'memory' in performance ? performance.memory.usedJSHeapSize : null;
  });
}

async function waitForReady(page) {
  const response = await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });
  assert.ok(response?.ok(), `production page returned ${String(response?.status())}`);
  await page.waitForSelector(
    '#space-canvas[data-renderer-ready="true"][data-camera-ready="true"]',
    { state: 'attached', timeout: 30_000 },
  );
  await page.waitForFunction(
    (telemetryProperty) => {
      const canvas = globalThis.document.querySelector('#space-canvas');
      return (
        canvas instanceof globalThis.HTMLCanvasElement &&
        canvas[telemetryProperty] !== undefined &&
        canvas[telemetryProperty].frameSampleCount > 0
      );
    },
    TELEMETRY_PROPERTY,
    { polling: 250, timeout: 60_000 },
  );
}

async function readWorkload(page) {
  return page.evaluate((telemetryProperty) => {
    const canvas = globalThis.document.querySelector('#space-canvas');
    if (!(canvas instanceof globalThis.HTMLCanvasElement))
      throw new Error('Telemetry canvas is missing.');
    const telemetry = canvas[telemetryProperty];
    if (telemetry === undefined) throw new Error('Render telemetry is missing.');
    return {
      drawCalls: telemetry.snapshot.drawCalls,
      triangles: telemetry.snapshot.triangles,
    };
  }, TELEMETRY_PROPERTY);
}

async function waitForStableWorkload(page) {
  let previous = null;
  let stableCount = 0;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await page.waitForTimeout(250);
    const current = await readWorkload(page);
    if (
      previous !== null &&
      current.drawCalls === previous.drawCalls &&
      current.triangles === previous.triangles &&
      current.drawCalls > 0 &&
      current.triangles > 0
    ) {
      stableCount += 1;
      if (stableCount >= STABLE_SNAPSHOT_COUNT) return current;
    } else {
      stableCount = 0;
    }
    previous = current;
  }
  throw new Error('Production workload did not settle into four identical snapshots.');
}

async function measurePage(browser, durationMs, allocationFixture, label) {
  console.log(`Performance gate page: ${label}`);
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
  const browserErrors = [];
  addBrowserErrorListeners(page, browserErrors);
  await installCooperativeFrameLoop(page, allocationFixture);
  await installHighQualitySetting(page);

  try {
    try {
      await waitForReady(page);
    } catch (error) {
      throw new Error(`${label} did not become ready: ${describeError(error)}; ${browserErrors.join(' | ')}`);
    }
    console.log(`Performance gate ready: ${label}`);
    await exposeGc(page);
    let workload = await waitForStableWorkload(page);
    console.log(`Performance gate workload stable: ${label}`);
    await page.waitForTimeout(allocationFixture ? FIXTURE_SETTLE_MS : HEAP_SETTLE_MS);
    console.log(`Performance gate settled: ${label}`);
    workload = await waitForStableWorkload(page);
    const beforeBytes = await forceGc(page);
    console.log(`Performance gate measuring: ${label}`);
    await page.waitForTimeout(durationMs);
    const afterBytes = await forceGc(page);
    console.log(`Performance gate measured: ${label}`);
    assert.deepEqual(browserErrors, []);
    return {
      heap: { afterBytes, beforeBytes, deltaBytes: afterBytes - beforeBytes },
      workload,
    };
  } finally {
    await page.close();
  }
}

async function runDrawFixture(browser, productionWorkload, golden) {
  console.log('Performance gate page: draw fixture');
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
  const browserErrors = [];
  addBrowserErrorListeners(page, browserErrors);
  await installCooperativeFrameLoop(page, false);
  await installHighQualitySetting(page);
  try {
    await waitForReady(page);
    console.log('Performance gate ready: draw fixture');
    await waitForStableWorkload(page);
    console.log('Performance gate workload stable: draw fixture');
    const injected = await page.evaluate(
      ({ drawCallOffset, telemetryProperty }) => {
        const canvas = globalThis.document.querySelector('#space-canvas');
        if (!(canvas instanceof globalThis.HTMLCanvasElement))
          throw new Error('Telemetry canvas is missing.');
        const telemetry = canvas[telemetryProperty];
        if (telemetry === undefined) throw new Error('Render telemetry is missing.');
        telemetry.snapshot.drawCalls += drawCallOffset;
        return {
          drawCalls: telemetry.snapshot.drawCalls,
          triangles: telemetry.snapshot.triangles,
        };
      },
      { drawCallOffset: golden.workload.drawCalls * 2, telemetryProperty: TELEMETRY_PROPERTY },
    );
    assert.deepEqual(browserErrors, []);
    console.log('Performance gate measured: draw fixture');
    const findings = validateWorkload(injected, golden.workload);
    assert.ok(
      findings.some((finding) => finding.startsWith('Draw calls must stay within')),
      `extra draw-call fixture unexpectedly passed: ${JSON.stringify({ findings, injected, productionWorkload })}`,
    );
    return { findings, injected };
  } finally {
    await page.close();
  }
}

async function main() {
  const golden = await readGolden();
  const bundle = await measureBundleSizes(resolve('dist'));
  const bundleFindings = validateBundleSizes(bundle, golden.bundle);
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
      headless: true,
      args: ['--enable-precise-memory-info', '--js-flags=--expose-gc'],
    });
    const production = await measurePage(browser, golden.heap.durationMs, false, 'production');
    const workloadFindings = validateWorkload(production.workload, golden.workload);
    const heapFindings = validateHeapGrowth(production.heap, golden.heap.maxRetainedGrowthBytes);
    if (PRODUCTION_ONLY) {
      const findings = [...bundleFindings, ...workloadFindings, ...heapFindings];
      process.stdout.write(
        `${JSON.stringify({ bundle, findings, golden, production }, null, 2)}\n`,
      );
      if (findings.length > 0) {
        throw new Error(`Performance gates failed: ${findings.join(' | ')}`);
      }
      return;
    }
    const allocationFixture = await measurePage(
      browser,
      golden.heap.fixtureDurationMs,
      true,
      'allocation fixture',
    );
    const allocationFixtureFindings = validateHeapGrowth(
      allocationFixture.heap,
      golden.heap.maxRetainedGrowthBytes,
    );
    assert.ok(
      allocationFixtureFindings.some((finding) => finding.startsWith('Retained heap growth')),
      `allocation fixture unexpectedly passed: ${JSON.stringify(allocationFixture)}`,
    );
    const drawFixture = await runDrawFixture(browser, production.workload, golden);
    const findings = [...bundleFindings, ...workloadFindings, ...heapFindings];
    const result = {
      allocationFixture: { findings: allocationFixtureFindings, ...allocationFixture },
      bundle,
      drawFixture,
      findings,
      golden,
      production,
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (findings.length > 0) {
      throw new Error(`Performance gates failed: ${findings.join(' | ')}`);
    }
  } catch (error) {
    console.error(describeError(error));
    process.exitCode = 1;
  } finally {
    if (browser !== undefined) await browser.close();
    await server.close();
    await assertPortAvailable(PORT, HOST);
  }
}

await main();
