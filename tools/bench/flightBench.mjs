import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { chromium } from 'playwright';
import { preview } from 'vite';

import { installHighQualitySetting } from '../perf/browserSettings.mjs';
import { measureBundleSizes } from '../perf/bundleMeasurement.mjs';
import { compareBenchmarkRuns } from '../perf/performanceGateUtils.mjs';
import {
  FIXED_FLIGHT_SEED,
  createFlightSchedule,
  summarizeFlightRun,
} from './flightBenchUtils.mjs';
import { assertPortAvailable } from './scaffoldBenchUtils.mjs';

const HOST = '127.0.0.1';
const PORT = 4177;
const PAGE_URL = `http://${HOST}:${String(PORT)}/solar-voyager/`;
const TELEMETRY_PROPERTY = 'solarVoyagerTelemetry';
const WARMUP_FRAMES = 120;
const STEADY_HEAP_SETTLE_FRAMES = 1_800;
const STEADY_HEAP_MEASURE_FRAMES = 1_800;
const DEFAULT_SAMPLE_FRAMES = 1_800;
const DEFAULT_OUTPUT = 'docs/bench/T0092-flight.json';

function readPositiveIntegerFlag(flag, fallback) {
  const index = process.argv.indexOf(flag);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${flag} must be followed by a positive integer.`);
  }
  return value;
}

function readOutputPath() {
  const index = process.argv.indexOf('--output');
  if (index < 0) return resolve(DEFAULT_OUTPUT);
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new RangeError('--output must be followed by a file path.');
  }
  return resolve(value);
}

function readGitSha() {
  const result = spawnSync('git', ['-c', 'safe.directory=*', 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(`Unable to read git SHA: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

function runBuild() {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath === undefined) throw new Error('Run the flight benchmark through npm run bench.');
  const result = spawnSync(process.execPath, [npmExecPath, 'run', 'build'], {
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`Production build failed with status ${String(result.status)}.`);
  }
}

function addBrowserErrorListeners(page, errors) {
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('crash', () => errors.push('page crash'));
}

async function waitForReady(page) {
  const response = await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });
  if (!response?.ok()) throw new Error(`Production page returned ${String(response?.status())}.`);
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
        canvas[telemetryProperty].frameSampleCount === 120
      );
    },
    TELEMETRY_PROPERTY,
    { timeout: 60_000 },
  );
}

async function readEnvironment(page) {
  return page.locator('#space-canvas').evaluate((element) => {
    if (!(element instanceof globalThis.HTMLCanvasElement)) {
      throw new Error('Expected the production canvas.');
    }
    const context = element.getContext('webgl2');
    const extension = context?.getExtension('WEBGL_debug_renderer_info');
    return {
      canvas: { height: element.height, width: element.width },
      renderer:
        context !== null && extension !== null
          ? String(context.getParameter(extension.UNMASKED_RENDERER_WEBGL))
          : 'unavailable',
      vendor:
        context !== null && extension !== null
          ? String(context.getParameter(extension.UNMASKED_VENDOR_WEBGL))
          : 'unavailable',
    };
  });
}

async function measureFlight(page, schedule) {
  return page.evaluate(
    ({
      schedule: flightSchedule,
      steadyHeapMeasureFrames,
      steadyHeapSettleFrames,
      telemetryProperty,
      warmupFrames,
    }) =>
      new Promise((resolvePromise, rejectPromise) => {
        const canvas = globalThis.document.querySelector('#space-canvas');
        if (!(canvas instanceof globalThis.HTMLCanvasElement)) {
          rejectPromise(new Error('Flight benchmark canvas is missing.'));
          return;
        }
        const telemetry = canvas[telemetryProperty];
        if (telemetry === undefined) {
          rejectPromise(new Error('Flight benchmark telemetry is missing.'));
          return;
        }
        const frameDeltasMs = new Float64Array(flightSchedule.sampleFrames);
        let focusEventIndex = 0;
        let framesToWarm = warmupFrames;
        let pathHeapAfterBytes = null;
        let pathHeapBeforeBytes = null;
        let maxDrawCalls = 0;
        let maxTriangles = 0;
        let previousFrameTimeMs = 0;
        let sampleIndex = 0;
        let steadyFramesRemaining = steadyHeapSettleFrames;
        let steadyHeapBeforeBytes = null;
        let zoomEventIndex = 0;

        function heapBytes() {
          return 'memory' in performance ? performance.memory.usedJSHeapSize : null;
        }

        function finishSteadyMeasurement() {
          steadyFramesRemaining -= 1;
          if (steadyFramesRemaining > 0) {
            globalThis.requestAnimationFrame(finishSteadyMeasurement);
            return;
          }
          globalThis.gc?.();
          globalThis.gc?.();
          resolvePromise({
            finalFocusLabel: globalThis.document.querySelector('#camera-focus-label')?.textContent,
            frameDeltasMs: Array.from(frameDeltasMs),
            maxDrawCalls,
            maxTriangles,
            pathHeapAfterBytes,
            pathHeapBeforeBytes,
            steadyHeapAfterBytes: heapBytes(),
            steadyHeapBeforeBytes,
          });
        }

        function settleSteadyHeap() {
          steadyFramesRemaining -= 1;
          if (steadyFramesRemaining > 0) {
            globalThis.requestAnimationFrame(settleSteadyHeap);
            return;
          }
          globalThis.gc?.();
          globalThis.gc?.();
          steadyHeapBeforeBytes = heapBytes();
          steadyFramesRemaining = steadyHeapMeasureFrames;
          globalThis.requestAnimationFrame(finishSteadyMeasurement);
        }

        function measureFrame(frameTimeMs) {
          if (framesToWarm > 0) {
            framesToWarm -= 1;
            if (framesToWarm === 0) {
              globalThis.gc?.();
              globalThis.gc?.();
              pathHeapBeforeBytes = heapBytes();
              previousFrameTimeMs = frameTimeMs;
            }
            globalThis.requestAnimationFrame(measureFrame);
            return;
          }

          frameDeltasMs[sampleIndex] = frameTimeMs - previousFrameTimeMs;
          previousFrameTimeMs = frameTimeMs;
          const focusEvent = flightSchedule.focusEvents[focusEventIndex];
          if (focusEvent !== undefined && focusEvent.frame === sampleIndex) {
            globalThis.dispatchEvent(
              new globalThis.KeyboardEvent('keydown', { key: focusEvent.key }),
            );
            focusEventIndex += 1;
          }
          const zoomEvent = flightSchedule.zoomEvents[zoomEventIndex];
          if (zoomEvent !== undefined && zoomEvent.frame === sampleIndex) {
            canvas.dispatchEvent(
              new globalThis.WheelEvent('wheel', {
                cancelable: true,
                deltaY: zoomEvent.delta,
              }),
            );
            zoomEventIndex += 1;
          }
          maxDrawCalls = Math.max(maxDrawCalls, telemetry.snapshot.drawCalls);
          maxTriangles = Math.max(maxTriangles, telemetry.snapshot.triangles);
          sampleIndex += 1;
          if (sampleIndex < flightSchedule.sampleFrames) {
            globalThis.requestAnimationFrame(measureFrame);
            return;
          }
          globalThis.gc?.();
          globalThis.gc?.();
          pathHeapAfterBytes = heapBytes();
          globalThis.requestAnimationFrame(settleSteadyHeap);
        }
        globalThis.requestAnimationFrame(measureFrame);
      }),
    {
      schedule,
      steadyHeapMeasureFrames: STEADY_HEAP_MEASURE_FRAMES,
      steadyHeapSettleFrames: STEADY_HEAP_SETTLE_FRAMES,
      telemetryProperty: TELEMETRY_PROPERTY,
      warmupFrames: WARMUP_FRAMES,
    },
  );
}

async function runOnce(browser, schedule, index) {
  console.log(`Flight benchmark run ${String(index + 1)}`);
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
  const errors = [];
  addBrowserErrorListeners(page, errors);
  await installHighQualitySetting(page);
  try {
    await waitForReady(page);
    const environment = await readEnvironment(page);
    const raw = await measureFlight(page, schedule);
    if (errors.length > 0) throw new Error(`Browser errors: ${errors.join(' | ')}`);
    const legs = schedule.legs.map((leg) => ({
      frameDeltasMs: raw.frameDeltasMs.slice(leg.startFrame, leg.endFrame),
      id: leg.id,
    }));
    const summary = summarizeFlightRun({ ...raw, legs });
    if (raw.finalFocusLabel !== 'Focus: Jupiter') {
      throw new Error(`Flight ended on an unexpected focus: ${String(raw.finalFocusLabel)}`);
    }
    return { environment, errors, finalFocusLabel: raw.finalFocusLabel, summary };
  } finally {
    await page.close();
  }
}

async function main() {
  const runsRequested = readPositiveIntegerFlag('--runs', 1);
  if (runsRequested > 2) throw new RangeError('--runs supports one or two benchmark runs.');
  const sampleFrames = readPositiveIntegerFlag('--sample-frames', DEFAULT_SAMPLE_FRAMES);
  const schedule = createFlightSchedule(FIXED_FLIGHT_SEED, sampleFrames);
  const outputPath = readOutputPath();
  runBuild();
  const bundle = await measureBundleSizes(resolve('dist'));
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
    const runs = [];
    for (let index = 0; index < runsRequested; index += 1) {
      runs.push(await runOnce(browser, schedule, index));
    }
    const stabilityFindings =
      runs.length === 2 ? compareBenchmarkRuns(runs[0].summary, runs[1].summary) : [];
    const report = {
      schemaVersion: 1,
      timestamp: new Date().toISOString(),
      gitSha: readGitSha(),
      bundle,
      environment: runs[0]?.environment,
      schedule,
      runs: runs.map(({ errors, finalFocusLabel, summary }) => ({
        errors,
        finalFocusLabel,
        summary,
      })),
      stability: { findings: stabilityFindings, limitFraction: 0.05 },
    };
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (stabilityFindings.length > 0) {
      throw new Error(`Flight benchmark is unstable: ${stabilityFindings.join(' | ')}`);
    }
  } finally {
    if (browser !== undefined) await browser.close();
    await server.close();
    await assertPortAvailable(PORT, HOST);
  }
}

await main();
