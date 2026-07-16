import { spawn, spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import { assertPortAvailable, percentile } from './scaffoldBenchUtils.mjs';

const HOST = '127.0.0.1';
const PORT = 4174;
const WARMUP_FRAMES = 120;
const SAMPLE_FRAMES = 600;
const REQUIRE_HARDWARE_GPU = process.argv.includes('--require-hardware-gpu');
const PAGE_URL = `http://${HOST}:${String(PORT)}/solar-voyager/`;
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

function readPositiveIntegerFlag(flag, fallback) {
  const flagIndex = process.argv.indexOf(flag);
  if (flagIndex === -1) return fallback;
  const rawValue = process.argv[flagIndex + 1];
  const value = Number(rawValue);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${flag} must be followed by a positive integer.`);
  }
  return value;
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

async function previewIsReady(pageUrl) {
  try {
    const response = await fetch(pageUrl, { signal: AbortSignal.timeout(1_000) });
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

function startPreview(port) {
  const previewProcess = spawn(
    process.execPath,
    [VITE_BIN_PATH, 'preview', '--host', HOST, '--port', String(port), '--strictPort'],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  const lifecycle = {
    child: previewProcess,
    closed: null,
    closedResult: null,
    spawnError: null,
  };

  lifecycle.closed = new Promise((resolvePromise) => {
    previewProcess.once('close', (exitCode, signal) => {
      lifecycle.closedResult = { exitCode, signal };
      resolvePromise(lifecycle.closedResult);
    });
  });
  previewProcess.once('error', (error) => {
    lifecycle.spawnError = error;
  });

  previewProcess.stdout.resume();
  previewProcess.stderr.resume();

  return lifecycle;
}

async function waitForPreview(lifecycle, pageUrl) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (lifecycle.spawnError !== null) {
      throw new Error('Unable to spawn the Vite preview process.', {
        cause: lifecycle.spawnError,
      });
    }

    if (lifecycle.closedResult !== null) {
      throw new Error(
        `Vite preview closed before becoming ready (${String(lifecycle.closedResult.exitCode)}, ${String(lifecycle.closedResult.signal)}).`,
      );
    }

    if (await previewIsReady(pageUrl)) {
      return;
    }

    await delay(100);
  }

  throw new Error(`Vite preview did not become ready at ${pageUrl}.`);
}

function waitForClose(lifecycle, timeoutMs) {
  if (lifecycle.closedResult !== null) {
    return Promise.resolve(true);
  }

  return new Promise((resolvePromise) => {
    let waiting = true;
    const timeoutId = setTimeout(() => {
      waiting = false;
      resolvePromise(false);
    }, timeoutMs);

    lifecycle.closed.then(() => {
      if (waiting) {
        waiting = false;
        clearTimeout(timeoutId);
        resolvePromise(true);
      }
    });
  });
}

async function stopPreview(lifecycle) {
  if (lifecycle === null) {
    return;
  }

  if (lifecycle.closedResult === null) {
    lifecycle.child.kill('SIGTERM');
  }

  const closedGracefully = await waitForClose(lifecycle, 5_000);

  if (!closedGracefully) {
    lifecycle.child.kill('SIGKILL');

    if (!(await waitForClose(lifecycle, 5_000))) {
      throw new Error(
        `Preview child ${String(lifecycle.child.pid)} did not close after forced termination.`,
      );
    }
  }

  await lifecycle.closed;
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

async function collectBenchmark(pageUrl) {
  const viewportWidth = readPositiveIntegerFlag('--viewport-width', 1280);
  const viewportHeight = readPositiveIntegerFlag('--viewport-height', 720);
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--enable-precise-memory-info',
      ...(REQUIRE_HARDWARE_GPU
        ? ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=default']
        : []),
    ],
  });
  const page = await browser.newPage({
    viewport: { width: viewportWidth, height: viewportHeight },
  });
  if (REQUIRE_HARDWARE_GPU) {
    await page.addInitScript(() => {
      const nativeRequestAnimationFrame = globalThis.requestAnimationFrame.bind(globalThis);
      const pendingQueries = [];
      const samplesNs = [];
      let pendingIndex = 0;
      let targetCallback;
      let context;
      let extension;
      let initializationAttempted = false;

      globalThis.__solarVoyagerGpuTiming = { error: null, samplesNs };

      function initializeTimerQuery() {
        if (initializationAttempted) return;
        initializationAttempted = true;
        const canvas = globalThis.document.querySelector('#space-canvas');
        if (!(canvas instanceof globalThis.HTMLCanvasElement)) {
          globalThis.__solarVoyagerGpuTiming.error = 'Space canvas unavailable.';
          return;
        }
        context = canvas.getContext('webgl2');
        extension = context?.getExtension('EXT_disjoint_timer_query_webgl2');
        if (context === null || extension === null) {
          globalThis.__solarVoyagerGpuTiming.error = 'EXT_disjoint_timer_query_webgl2 unavailable.';
        }
      }

      function collectAvailableQueries() {
        while (pendingIndex < pendingQueries.length) {
          const query = pendingQueries[pendingIndex];
          if (!context.getQueryParameter(query, context.QUERY_RESULT_AVAILABLE)) return;
          const disjoint = context.getParameter(extension.GPU_DISJOINT_EXT);
          const elapsedNs = context.getQueryParameter(query, context.QUERY_RESULT);
          context.deleteQuery(query);
          pendingIndex += 1;
          if (!disjoint) samplesNs.push(elapsedNs);
        }
      }

      globalThis.requestAnimationFrame = (callback) => {
        targetCallback ??= callback;
        return nativeRequestAnimationFrame((timeMs) => {
          if (callback !== targetCallback) {
            callback(timeMs);
            return;
          }
          initializeTimerQuery();
          if (context === undefined || extension === undefined) {
            callback(timeMs);
            return;
          }
          collectAvailableQueries();
          const query = context.createQuery();
          if (query === null) {
            globalThis.__solarVoyagerGpuTiming.error = 'Unable to create GPU timer query.';
            callback(timeMs);
            return;
          }
          context.beginQuery(extension.TIME_ELAPSED_EXT, query);
          try {
            callback(timeMs);
          } finally {
            context.endQuery(extension.TIME_ELAPSED_EXT);
            pendingQueries.push(query);
          }
        });
      };
    });
  }
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
    await page.goto(pageUrl, { waitUntil: 'networkidle' });

    const gpu = await page.locator('#space-canvas').evaluate((element) => {
      if (!(element instanceof globalThis.HTMLCanvasElement)) {
        throw new Error('Expected #space-canvas to be a canvas element.');
      }
      const context = element.getContext('webgl2');
      const extension = context?.getExtension('WEBGL_debug_renderer_info');
      return {
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
    if (REQUIRE_HARDWARE_GPU && /SwiftShader|llvmpipe|Software|Basic Render/iu.test(gpu.renderer)) {
      throw new Error(`Hardware benchmark selected a software renderer: ${gpu.renderer}`);
    }

    const measurement = await page.evaluate(
      ({ sampleFrames, warmupFrames }) =>
        new Promise((resolvePromise) => {
          const frameDeltasMs = new Float64Array(sampleFrames);
          let framesToWarm = warmupFrames;
          let previousFrameTimeMs = 0;
          let sampleIndex = 0;
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

            frameDeltasMs[sampleIndex] = frameTimeMs - previousFrameTimeMs;
            sampleIndex += 1;
            previousFrameTimeMs = frameTimeMs;

            if (sampleIndex < sampleFrames) {
              globalThis.requestAnimationFrame(measureFrame);
              return;
            }

            const heapAfterBytes = readHeapBytes();
            resolvePromise({
              frameDeltasMs: Array.from(frameDeltasMs),
              heapAfterBytes,
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
    const gpuTiming = REQUIRE_HARDWARE_GPU
      ? await page.evaluate(() => globalThis.__solarVoyagerGpuTiming)
      : null;
    if (gpuTiming?.error !== null && gpuTiming?.error !== undefined) {
      throw new Error(`GPU timing failed: ${gpuTiming.error}`);
    }
    const sortedGpuRenderMs =
      gpuTiming === null
        ? []
        : gpuTiming.samplesNs
            .slice(-SAMPLE_FRAMES)
            .map((elapsedNs) => elapsedNs / 1_000_000)
            .toSorted((left, right) => left - right);
    if (REQUIRE_HARDWARE_GPU && sortedGpuRenderMs.length < SAMPLE_FRAMES) {
      throw new Error(
        `GPU timing returned ${String(sortedGpuRenderMs.length)} samples; expected ${String(SAMPLE_FRAMES)}.`,
      );
    }
    const result = {
      timestamp: new Date().toISOString(),
      gitSha: readGitSha(),
      warmupFrames: WARMUP_FRAMES,
      sampleFrames: SAMPLE_FRAMES,
      medianMs: roundMilliseconds(percentile(sortedFrameDeltasMs, 0.5)),
      p75Ms: roundMilliseconds(percentile(sortedFrameDeltasMs, 0.75)),
      p99Ms: roundMilliseconds(percentile(sortedFrameDeltasMs, 0.99)),
      gpu,
      canvas,
      consoleErrors,
      pageErrors,
    };

    if (sortedGpuRenderMs.length > 0) {
      result.gpuRenderMedianMs = roundMilliseconds(percentile(sortedGpuRenderMs, 0.5));
      result.gpuRenderP75Ms = roundMilliseconds(percentile(sortedGpuRenderMs, 0.75));
      result.gpuRenderP99Ms = roundMilliseconds(percentile(sortedGpuRenderMs, 0.99));
    }

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
  let previewLifecycle = null;

  try {
    await runBuild();
    await assertPortAvailable(PORT, HOST);
    previewLifecycle = startPreview(PORT);
    await waitForPreview(previewLifecycle, PAGE_URL);
    console.log(`Benchmark preview port: ${String(PORT)}`);

    const result = await collectBenchmark(PAGE_URL);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');

    if (result.consoleErrors.length > 0 || result.pageErrors.length > 0) {
      throw new Error('Browser errors were recorded during the scaffold benchmark.');
    }

    console.log(JSON.stringify(result, null, 2));
  } finally {
    await stopPreview(previewLifecycle);

    if (previewLifecycle !== null) {
      await assertPortAvailable(PORT, HOST);
      console.log(`Benchmark preview port released: ${String(PORT)}`);
    }
  }
}

await main();
