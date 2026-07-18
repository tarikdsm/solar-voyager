import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { chromium } from 'playwright';
import { createServer, preview } from 'vite';

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
const SAVE_STORAGE_KEY = 'solar-voyager.save.v2';
const STEADY_HEAP_SETTLE_MS = 30_000;
const STEADY_HEAP_MEASURE_MS = 30_000;
const DEFAULT_SAMPLE_FRAMES = 900;
const DEFAULT_OUTPUT = 'docs/bench/T0092-flight.json';
const PRIMING_RUNS = 2;

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

async function createCanonicalFlightRoute() {
  const loader = await createServer({
    appType: 'custom',
    logLevel: 'error',
    root: process.cwd(),
    server: { middlewareMode: true },
  });
  try {
    const routeModule = await loader.ssrLoadModule('/src/game/flightBenchmarkRoute.ts');
    const route = routeModule.createFlightBenchmarkRoute();
    if (!Array.isArray(route) || route.length !== 4) {
      throw new Error('Canonical flight route must contain four checkpoints.');
    }
    return route;
  } finally {
    await loader.close();
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
  return page.evaluate((telemetryProperty) => {
    const canvas = globalThis.document.querySelector('#space-canvas');
    if (!(canvas instanceof globalThis.HTMLCanvasElement)) {
      throw new Error('Expected the production canvas.');
    }
    const telemetry = canvas[telemetryProperty];
    if (telemetry === undefined) throw new Error('Expected production telemetry.');
    return {
      canvas: { height: canvas.height, width: canvas.width },
      renderer: telemetry.snapshot.context.rendererName,
      softwareRasterizer: telemetry.snapshot.context.softwareRasterizer,
    };
  }, TELEMETRY_PROPERTY);
}

async function validateFlightRoute(page, route) {
  const evidence = [];
  for (const checkpoint of route) {
    const loaded = await page.evaluate(
      ({ checkpoint: routeCheckpoint, saveStorageKey }) => {
        const loadButton = globalThis.document.querySelector('#session-load');
        const saveButton = globalThis.document.querySelector('#session-save');
        if (
          !(loadButton instanceof globalThis.HTMLButtonElement) ||
          !(saveButton instanceof globalThis.HTMLButtonElement)
        ) {
          throw new Error('Flight benchmark session controls are missing.');
        }
        globalThis.localStorage.setItem(saveStorageKey, routeCheckpoint.saveJson);
        loadButton.click();
        saveButton.click();
        const savedJson = globalThis.localStorage.getItem(saveStorageKey);
        if (savedJson === null) throw new Error('Loaded checkpoint could not be saved.');
        const saved = JSON.parse(savedJson);
        return {
          distanceToTargetKm: routeCheckpoint.distanceToTargetKm,
          dominantBodyId: routeCheckpoint.dominantBodyId,
          loadedSimTimeSec: saved.simulation.simTimeSec,
          loadedTargetBodyId: saved.simulation.targetBodyId,
          requestedSimTimeSec: routeCheckpoint.simTimeSec,
          targetBodyId: routeCheckpoint.targetBodyId,
        };
      },
      { checkpoint, saveStorageKey: SAVE_STORAGE_KEY },
    );
    await page.waitForFunction(
      (dominantBodyId) =>
        globalThis.document.querySelector('#orbit-title')?.textContent?.toLowerCase() ===
        dominantBodyId,
      checkpoint.dominantBodyId,
      { timeout: 5_000 },
    );
    evidence.push({ ...loaded, renderedDominantBody: checkpoint.dominantBodyId });
  }
  return evidence;
}

async function forceGc(page) {
  return page.evaluate(() => {
    if (typeof globalThis.gc !== 'function') throw new Error('Chromium did not expose gc().');
    globalThis.gc();
    globalThis.gc();
    return 'memory' in performance ? performance.memory.usedJSHeapSize : null;
  });
}

async function measureFlight(page, schedule, route) {
  return page.evaluate(
    ({ route: flightRoute, saveStorageKey, schedule: flightSchedule, telemetryProperty }) =>
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
        const loadButton = globalThis.document.querySelector('#session-load');
        const saveButton = globalThis.document.querySelector('#session-save');
        if (
          !(loadButton instanceof globalThis.HTMLButtonElement) ||
          !(saveButton instanceof globalThis.HTMLButtonElement)
        ) {
          rejectPromise(new Error('Flight benchmark session controls are missing.'));
          return;
        }
        const frameDeltasMs = new Float64Array(flightSchedule.sampleFrames);
        const frameWorkMs = new Float64Array(flightSchedule.sampleFrames);
        const checkpointEvidence = [];
        let focusEventIndex = 0;
        let maxDrawCalls = 0;
        let maxTriangles = 0;
        let previousFrameTimeMs = performance.now();
        let sampleIndex = 0;
        let zoomEventIndex = 0;

        function loadCheckpoint(checkpoint) {
          globalThis.localStorage.setItem(saveStorageKey, checkpoint.saveJson);
          loadButton.click();
          saveButton.click();
          const savedJson = globalThis.localStorage.getItem(saveStorageKey);
          if (savedJson === null) throw new Error('Loaded checkpoint could not be saved.');
          const saved = JSON.parse(savedJson);
          checkpointEvidence.push({
            distanceToTargetKm: checkpoint.distanceToTargetKm,
            dominantBodyId: checkpoint.dominantBodyId,
            loadedSimTimeSec: saved.simulation.simTimeSec,
            loadedTargetBodyId: saved.simulation.targetBodyId,
            requestedSimTimeSec: checkpoint.simTimeSec,
            targetBodyId: checkpoint.targetBodyId,
          });
        }

        function measureFrame(frameTimeMs) {
          frameDeltasMs[sampleIndex] = frameTimeMs - previousFrameTimeMs;
          frameWorkMs[sampleIndex] = Math.max(0, performance.now() - frameTimeMs);
          previousFrameTimeMs = frameTimeMs;
          const focusEvent = flightSchedule.focusEvents[focusEventIndex];
          if (focusEvent !== undefined && focusEvent.frame === sampleIndex) {
            const checkpoint = flightRoute[focusEventIndex + 1];
            if (checkpoint === undefined) throw new Error('Flight checkpoint schedule is sparse.');
            loadCheckpoint(checkpoint);
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
          const finalCheckpoint = flightRoute[3];
          if (finalCheckpoint === undefined) throw new Error('Final flight checkpoint is missing.');
          loadCheckpoint(finalCheckpoint);
          globalThis.requestAnimationFrame(() => {
            resolvePromise({
              checkpointEvidence,
              finalFocusLabel:
                globalThis.document.querySelector('#camera-focus-label')?.textContent,
              frameDeltasMs: Array.from(frameDeltasMs),
              frameWorkMs: Array.from(frameWorkMs),
              maxDrawCalls,
              maxTriangles,
            });
          });
        }
        const initialCheckpoint = flightRoute[0];
        if (initialCheckpoint === undefined)
          throw new Error('Initial flight checkpoint is missing.');
        loadCheckpoint(initialCheckpoint);
        previousFrameTimeMs = performance.now();
        globalThis.requestAnimationFrame(measureFrame);
      }),
    {
      route,
      saveStorageKey: SAVE_STORAGE_KEY,
      schedule,
      telemetryProperty: TELEMETRY_PROPERTY,
    },
  );
}

async function runOnce(browser, schedule, route, index) {
  console.log(`Flight benchmark run ${String(index + 1)}`);
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
  const errors = [];
  addBrowserErrorListeners(page, errors);
  await installHighQualitySetting(page);
  try {
    await waitForReady(page);
    if (errors.length > 0) throw new Error(`Browser errors: ${errors.join(' | ')}`);
    const environment = await readEnvironment(page);
    const routeEvidence = await validateFlightRoute(page, route);
    const pathHeapBeforeBytes = await forceGc(page);
    const raw = await measureFlight(page, schedule, route);
    const pathHeapAfterBytes = await forceGc(page);
    await page.waitForTimeout(STEADY_HEAP_SETTLE_MS);
    const steadyHeapBeforeBytes = await forceGc(page);
    await page.waitForTimeout(STEADY_HEAP_MEASURE_MS);
    const steadyHeapAfterBytes = await forceGc(page);
    if (errors.length > 0) throw new Error(`Browser errors: ${errors.join(' | ')}`);
    const legs = schedule.legs.map((leg) => ({
      frameDeltasMs: raw.frameDeltasMs.slice(leg.startFrame, leg.endFrame),
      frameWorkMs: raw.frameWorkMs.slice(leg.startFrame, leg.endFrame),
      id: leg.id,
    }));
    const summary = summarizeFlightRun({
      ...raw,
      legs,
      pathHeapAfterBytes,
      pathHeapBeforeBytes,
      steadyHeapAfterBytes,
      steadyHeapBeforeBytes,
    });
    if (raw.finalFocusLabel !== 'Focus: Jupiter') {
      throw new Error(`Flight ended on an unexpected focus: ${String(raw.finalFocusLabel)}`);
    }
    for (const checkpoint of raw.checkpointEvidence) {
      if (
        checkpoint.loadedSimTimeSec !== checkpoint.requestedSimTimeSec ||
        checkpoint.loadedTargetBodyId !== checkpoint.targetBodyId
      ) {
        throw new Error(`Flight checkpoint was not executed: ${JSON.stringify(checkpoint)}`);
      }
    }
    return {
      checkpointEvidence: raw.checkpointEvidence,
      environment,
      errors,
      finalFocusLabel: raw.finalFocusLabel,
      routeEvidence,
      summary,
    };
  } finally {
    await page.close();
  }
}

async function primeBrowser(browser, schedule, route, index) {
  console.log(`Flight benchmark cache priming ${String(index + 1)}/${String(PRIMING_RUNS)}`);
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
  const errors = [];
  addBrowserErrorListeners(page, errors);
  await installHighQualitySetting(page);
  try {
    await waitForReady(page);
    const raw = await measureFlight(page, schedule, route);
    if (errors.length > 0) throw new Error(`Browser errors: ${errors.join(' | ')}`);
    if (raw.finalFocusLabel !== 'Focus: Jupiter') {
      throw new Error(`Priming ended on an unexpected focus: ${String(raw.finalFocusLabel)}`);
    }
  } finally {
    await page.close();
  }
}

async function launchBenchmarkBrowser() {
  const sharedArgs = ['--enable-precise-memory-info', '--js-flags=--expose-gc'];
  try {
    const hardwareArgs =
      process.platform === 'win32'
        ? [...sharedArgs, '--ignore-gpu-blocklist', '--use-angle=d3d11']
        : sharedArgs;
    return await chromium.launch({ channel: 'chrome', headless: true, args: hardwareArgs });
  } catch (error) {
    console.warn(
      `Stable Chrome is unavailable; falling back to bundled Chromium: ${error instanceof Error ? error.message : String(error)}`,
    );
    return chromium.launch({ headless: true, args: sharedArgs });
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
  const route = await createCanonicalFlightRoute();
  await assertPortAvailable(PORT, HOST);
  const server = await preview({
    root: process.cwd(),
    base: '/solar-voyager/',
    logLevel: 'error',
    preview: { host: HOST, port: PORT, strictPort: true },
  });
  let browser;
  try {
    browser = await launchBenchmarkBrowser();
    for (let index = 0; index < PRIMING_RUNS; index += 1) {
      await primeBrowser(browser, schedule, route, index);
    }
    const runs = [];
    for (let index = 0; index < runsRequested; index += 1) {
      runs.push(await runOnce(browser, schedule, route, index));
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
      runs: runs.map(({ checkpointEvidence, errors, finalFocusLabel, routeEvidence, summary }) => ({
        checkpointEvidence,
        errors,
        finalFocusLabel,
        routeEvidence,
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
