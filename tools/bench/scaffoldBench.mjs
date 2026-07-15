import { spawn, spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import { percentile } from './scaffoldBenchUtils.mjs';

const HOST = '127.0.0.1';
const WARMUP_FRAMES = 120;
const SAMPLE_FRAMES = 600;
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

function pageUrlForPort(port) {
  return `http://${HOST}:${String(port)}/solar-voyager/`;
}

function useAvailablePort(port) {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createServer();

    server.once('error', rejectPromise);
    server.listen(port, HOST, () => {
      const address = server.address();

      if (address === null || typeof address === 'string') {
        server.close(() => {
          rejectPromise(new Error('Unable to determine the benchmark preview port.'));
        });
        return;
      }

      server.close((error) => {
        if (error === undefined) {
          resolvePromise(address.port);
          return;
        }

        rejectPromise(error);
      });
    });
  });
}

function findAvailablePort() {
  return useAvailablePort(0);
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
    await page.goto(pageUrl, { waitUntil: 'networkidle' });

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
  let previewLifecycle = null;
  let previewPort = null;

  try {
    await runBuild();
    previewPort = await findAvailablePort();
    const pageUrl = pageUrlForPort(previewPort);
    previewLifecycle = startPreview(previewPort);
    await waitForPreview(previewLifecycle, pageUrl);
    console.log(`Benchmark preview port: ${String(previewPort)}`);

    const result = await collectBenchmark(pageUrl);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');

    if (result.consoleErrors.length > 0 || result.pageErrors.length > 0) {
      throw new Error('Browser errors were recorded during the scaffold benchmark.');
    }

    console.log(JSON.stringify(result, null, 2));
  } finally {
    await stopPreview(previewLifecycle);

    if (previewLifecycle !== null && previewPort !== null) {
      await useAvailablePort(previewPort);
      console.log(`Benchmark preview port released: ${String(previewPort)}`);
    }
  }
}

await main();
