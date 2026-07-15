import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const HOST = '127.0.0.1';
const PORT = 4174;
const WARMUP_FRAMES = 120;
const SAMPLE_FRAMES = 600;
const PAGE_URL = `http://${HOST}:${PORT}/solar-voyager/`;
const VITE_BIN_PATH = fileURLToPath(
  new URL('../../node_modules/vite/bin/vite.js', import.meta.url),
);

function readOutputPath() {
  const outputFlagIndex = process.argv.indexOf('--output');
  const outputArgument = process.argv[outputFlagIndex + 1];

  if (outputFlagIndex === -1 || outputArgument === undefined || outputArgument.startsWith('--')) {
    throw new Error('Usage: npm run bench:scaffold -- --output <path>');
  }

  return resolve(outputArgument);
}

function runBuild() {
  return new Promise((resolvePromise, rejectPromise) => {
    const npmExecPath = process.env.npm_execpath;

    if (npmExecPath === undefined) {
      rejectPromise(new Error('Run this benchmark through npm run bench:scaffold.'));
      return;
    }

    const buildProcess = spawn(process.execPath, [npmExecPath, 'run', 'build'], {
      stdio: 'inherit',
      windowsHide: true,
    });

    buildProcess.once('error', rejectPromise);
    buildProcess.once('exit', (exitCode, signal) => {
      if (exitCode === 0) {
        resolvePromise();
        return;
      }

      rejectPromise(
        new Error(`Build failed with exit code ${String(exitCode)} (${String(signal)}).`),
      );
    });
  });
}

async function previewIsReady() {
  try {
    const response = await fetch(PAGE_URL, { signal: AbortSignal.timeout(1_000) });
    const html = await response.text();
    return response.ok && html.includes('id="space-canvas"') && !html.includes('@vite/client');
  } catch {
    return false;
  }
}

function delay(delayMs) {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, delayMs);
  });
}

async function startOrReusePreview() {
  if (await previewIsReady()) {
    return null;
  }

  const previewProcess = spawn(
    process.execPath,
    [VITE_BIN_PATH, 'preview', '--host', HOST, '--port', String(PORT), '--strictPort'],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );

  previewProcess.stdout.resume();
  previewProcess.stderr.resume();

  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await previewIsReady()) {
      return previewProcess;
    }

    if (previewProcess.exitCode !== null) {
      throw new Error(
        `Vite preview exited before becoming ready (${String(previewProcess.exitCode)}).`,
      );
    }

    await delay(100);
  }

  previewProcess.kill('SIGTERM');
  throw new Error(`Vite preview did not become ready at ${PAGE_URL}.`);
}

async function stopPreview(previewProcess) {
  if (previewProcess === null || previewProcess.exitCode !== null) {
    return;
  }

  previewProcess.kill('SIGTERM');

  await Promise.race([
    once(previewProcess, 'exit'),
    delay(5_000).then(() => {
      if (previewProcess.exitCode === null) {
        previewProcess.kill('SIGKILL');
      }
    }),
  ]);
}

function percentile(sortedValues, fraction) {
  const position = (sortedValues.length - 1) * fraction;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const lowerValue = sortedValues[lowerIndex];
  const upperValue = sortedValues[upperIndex];

  if (lowerValue === undefined || upperValue === undefined) {
    throw new Error('Cannot calculate a percentile without frame samples.');
  }

  return lowerValue + (upperValue - lowerValue) * (position - lowerIndex);
}

function roundMilliseconds(value) {
  return Number(value.toFixed(3));
}

function readGitSha() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf8',
    windowsHide: true,
  });

  if (result.status !== 0) {
    throw new Error(`Unable to read git SHA: ${result.stderr.trim()}`);
  }

  return result.stdout.trim();
}

async function collectBenchmark() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--enable-precise-memory-info'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const consoleErrors = [];
  const pageErrors = [];

  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });
  page.on('pageerror', (error) => {
    pageErrors.push(error.message);
  });

  try {
    await page.goto(PAGE_URL, { waitUntil: 'networkidle' });

    const measurement = await page.evaluate(
      ({ sampleFrames, warmupFrames }) =>
        new Promise((resolvePromise) => {
          const frameDeltasMs = [];
          let framesToWarm = warmupFrames;
          let previousFrameTimeMs = 0;
          let heapBeforeBytes = null;

          function readHeapBytes() {
            if (!('memory' in performance)) {
              return null;
            }

            return performance.memory.usedJSHeapSize;
          }

          function measureFrame(frameTimeMs) {
            if (framesToWarm > 0) {
              framesToWarm -= 1;

              if (framesToWarm === 0) {
                previousFrameTimeMs = frameTimeMs;
                heapBeforeBytes = readHeapBytes();
              }

              globalThis.requestAnimationFrame(measureFrame);
              return;
            }

            frameDeltasMs.push(frameTimeMs - previousFrameTimeMs);
            previousFrameTimeMs = frameTimeMs;

            if (frameDeltasMs.length < sampleFrames) {
              globalThis.requestAnimationFrame(measureFrame);
              return;
            }

            resolvePromise({
              frameDeltasMs,
              heapAfterBytes: readHeapBytes(),
              heapBeforeBytes,
            });
          }

          globalThis.requestAnimationFrame(measureFrame);
        }),
      { sampleFrames: SAMPLE_FRAMES, warmupFrames: WARMUP_FRAMES },
    );

    const canvas = await page.locator('#space-canvas').evaluate((element) => {
      if (!(element instanceof globalThis.HTMLCanvasElement)) {
        throw new Error('Expected #space-canvas to be a canvas element.');
      }

      const bounds = element.getBoundingClientRect();
      return {
        backingHeight: element.height,
        backingWidth: element.width,
        cssHeight: bounds.height,
        cssWidth: bounds.width,
      };
    });

    const sortedFrameDeltasMs = measurement.frameDeltasMs.toSorted((left, right) => left - right);
    const result = {
      timestamp: new Date().toISOString(),
      gitSha: readGitSha(),
      warmupFrames: WARMUP_FRAMES,
      sampleFrames: SAMPLE_FRAMES,
      medianMs: roundMilliseconds(percentile(sortedFrameDeltasMs, 0.5)),
      p75Ms: roundMilliseconds(percentile(sortedFrameDeltasMs, 0.75)),
      p99Ms: roundMilliseconds(percentile(sortedFrameDeltasMs, 0.99)),
      canvas,
      consoleErrors,
      pageErrors,
    };

    if (measurement.heapBeforeBytes !== null && measurement.heapAfterBytes !== null) {
      result.heapDeltaBytes = measurement.heapAfterBytes - measurement.heapBeforeBytes;
    }

    return result;
  } finally {
    await browser.close();
  }
}

async function main() {
  const outputPath = readOutputPath();
  let previewProcess = null;

  try {
    await runBuild();
    previewProcess = await startOrReusePreview();

    const result = await collectBenchmark();
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');

    if (result.consoleErrors.length > 0 || result.pageErrors.length > 0) {
      throw new Error('Browser errors were recorded during the scaffold benchmark.');
    }

    console.log(JSON.stringify(result, null, 2));
  } finally {
    await stopPreview(previewProcess);
  }
}

await main();
