import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { chromium } from 'playwright';
import { createServer } from 'vite';

import { qualityRunOrder, summarizeQualitySamples } from './proceduralSunQualityBenchUtils.mjs';

const HOST = '127.0.0.1';
const PORT = 4181;
const REQUIRE_HARDWARE_GPU = process.argv.includes('--require-hardware-gpu');

function positiveIntegerFlag(flag, fallback) {
  const index = process.argv.indexOf(flag);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${flag} requires a positive integer.`);
  }
  return value;
}

function outputPath() {
  const index = process.argv.indexOf('--output');
  const value = process.argv[index + 1];
  if (index < 0 || value === undefined || value.startsWith('--')) {
    throw new Error('Usage: --output <path> is required.');
  }
  return resolve(value);
}

const width = positiveIntegerFlag('--viewport-width', 1920);
const height = positiveIntegerFlag('--viewport-height', 1080);
const samplesPerRun = positiveIntegerFlag('--samples-per-run', 180);
const destination = outputPath();
const pageUrl = `http://${HOST}:${PORT}/solar-voyager/tests/render/proceduralSun.html?width=${width}&height=${height}`;
const server = await createServer({
  server: { host: HOST, port: PORT, strictPort: true },
  logLevel: 'error',
});
let browser;

try {
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    args: REQUIRE_HARDWARE_GPU
      ? [
          '--enable-webgl',
          '--ignore-gpu-blocklist',
          '--use-angle=default',
          '--force_high_performance_gpu',
        ]
      : [],
  });
  const page = await browser.newPage({ viewport: { width, height } });
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  try {
    await page.waitForFunction(() => globalThis.__proceduralSunHarness !== undefined, null, {
      timeout: 60_000,
    });
  } catch (error) {
    const diagnostic = {
      consoleErrors,
      pageErrors,
      title: await page.title(),
      url: page.url(),
      canvasCount: await page.locator('#procedural-sun-canvas').count(),
    };
    throw new Error(`Procedural Sun harness did not initialize: ${JSON.stringify(diagnostic)}`, {
      cause: error,
    });
  }

  const gpu = await page.locator('#procedural-sun-canvas').evaluate((element) => {
    if (!(element instanceof globalThis.HTMLCanvasElement))
      throw new Error('Sun canvas is missing.');
    const context = element.getContext('webgl2');
    if (context === null) throw new Error('WebGL2 context is missing.');
    const debug = context.getExtension('WEBGL_debug_renderer_info');
    return {
      renderer:
        debug === null
          ? 'unavailable'
          : String(context.getParameter(debug.UNMASKED_RENDERER_WEBGL)),
      vendor:
        debug === null ? 'unavailable' : String(context.getParameter(debug.UNMASKED_VENDOR_WEBGL)),
      timerQuery: context.getExtension('EXT_disjoint_timer_query_webgl2') !== null,
    };
  });
  if (REQUIRE_HARDWARE_GPU && /SwiftShader|llvmpipe|Software|Basic Render/iu.test(gpu.renderer)) {
    throw new Error(`Hardware benchmark selected a software renderer: ${gpu.renderer}`);
  }
  assert.equal(gpu.timerQuery, true, 'GPU timer query extension is unavailable.');

  const rawSamples = { full: [], minimum: [] };
  const runOrder = qualityRunOrder();
  for (const quality of runOrder) {
    const samples = await page.evaluate(
      async ({ requestedQuality, requestedSamples }) => {
        const harness = globalThis.__proceduralSunHarness;
        if (harness === undefined) throw new Error('Procedural Sun harness is unavailable.');
        return harness.measureQualityGpu(requestedQuality, requestedSamples);
      },
      { requestedQuality: quality, requestedSamples: samplesPerRun },
    );
    rawSamples[quality].push(...samples);
  }

  const summary = summarizeQualitySamples(rawSamples);
  assert.equal(rawSamples.full.length, rawSamples.minimum.length);
  assert.ok(rawSamples.full.length >= samplesPerRun * 2);
  assert.equal(summary.minimumCheaper, true, JSON.stringify(summary));
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(consoleErrors, []);

  const result = {
    schemaVersion: 1,
    timestampUtc: new Date().toISOString(),
    sha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    adapter: gpu,
    resolution: { width, height, pixelRatio: 1 },
    samplesPerRun,
    runOrder,
    rawSamples,
    summary,
  };
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({ ...result, rawSamples: undefined }, null, 2)}\n`);
} finally {
  if (browser !== undefined) await browser.close();
  await server.close();
}
