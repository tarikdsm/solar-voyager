import assert from 'node:assert/strict';

import { chromium } from 'playwright';
import { preview } from 'vite';

import { assertPortAvailable } from '../bench/scaffoldBenchUtils.mjs';
import { installHighQualitySetting } from '../perf/browserSettings.mjs';

const HOST = '127.0.0.1';
const PORT = 4202;
const PAGE_URL = `http://${HOST}:${String(PORT)}/solar-voyager/`;
const FIRST_PLAYABLE_CEILING_MS = 5_000;
const EXPECTED_CRITICAL_FILES = [
  'data/stars.bin',
  'public/assets/manifest.json',
  'public/assets/textures/earth_albedo_tier2.ktx2',
  'public/assets/textures/moon_albedo_tier2.ktx2',
];

function collectBrowserErrors(page) {
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('crash', () => pageErrors.push('page crash'));
  return { consoleErrors, pageErrors };
}

function criticalFileFor(url) {
  const path = new URL(url).pathname.replace('/solar-voyager/', '');
  if (/^assets\/stars-[^/]+\.bin$/u.test(path)) return 'data/stars.bin';
  if (path === 'assets/manifest.json') return 'public/assets/manifest.json';
  if (path.startsWith('assets/textures/') || path.startsWith('assets/models/')) {
    return `public/${path}`;
  }
  return null;
}

async function readStartup(page) {
  return page.evaluate(() => {
    const canvas = globalThis.document.querySelector('#space-canvas');
    if (!(canvas instanceof globalThis.HTMLCanvasElement)) throw new Error('canvas missing');
    const startup = canvas.solarVoyagerStartup;
    if (startup === undefined) throw new Error('startup diagnostic missing');
    const descriptors = Object.values(Object.getOwnPropertyDescriptors(startup));
    return {
      depthStrategy: canvas.dataset.depthStrategy ?? null,
      devicePixelRatio: globalThis.devicePixelRatio,
      encodedBodyBytes: startup.encodedBodyBytes,
      errorCount: startup.errorCount,
      errorMessage: startup.errorMessage,
      failedStage: startup.failedStage,
      firstPlayableMs: startup.firstPlayableMs,
      frozen: Object.isFrozen(startup),
      nullPrototype: Object.getPrototypeOf(startup) === null,
      probeMeanMs: startup.probeMeanMs,
      programCountAtReady: startup.programCountAtReady,
      programCountAfterFirstFrame: startup.programCountAfterFirstFrame,
      programCountCurrent: startup.programCountCurrent,
      progress: startup.progress,
      qualitySource: startup.qualitySource,
      readOnly: descriptors.every(
        (descriptor) =>
          descriptor.configurable === false &&
          (descriptor.get === undefined
            ? descriptor.writable === false
            : descriptor.set === undefined),
      ),
      resourceCount: startup.resourceCount,
      rendererName: canvas.dataset.rendererName ?? null,
      selectedRung: startup.selectedRung,
      softwareRasterizer: canvas.dataset.softwareRasterizer ?? null,
      stage: startup.stage,
      transferBytes: startup.transferBytes,
    };
  });
}

async function waitForReady(page) {
  await page.waitForFunction(
    () => {
      const canvas = globalThis.document.querySelector('#space-canvas');
      return (
        canvas instanceof globalThis.HTMLCanvasElement &&
        canvas.dataset.startupStage === 'ready' &&
        canvas.solarVoyagerStartup?.stage === 'ready'
      );
    },
    undefined,
    { timeout: 30_000 },
  );
}

async function runColdLoad(browser) {
  const context = await browser.newContext({ viewport: { width: 1_280, height: 720 } });
  const page = await context.newPage();
  const errors = collectBrowserErrors(page);
  await page.addInitScript(() => {
    const linkedPrograms = [];
    const nativeLinkProgram = globalThis.WebGL2RenderingContext.prototype.linkProgram;
    globalThis.WebGL2RenderingContext.prototype.linkProgram = function (program) {
      const labels = (this.getAttachedShaders(program) ?? []).map((shader) => {
        const source = this.getShaderSource(shader) ?? '';
        const names = [...source.matchAll(/#define ([A-Z][A-Z0-9_]*)(?: ([^\n]+))?/gu)]
          .filter((match) => !['HIGH_PRECISION', 'SHADER_TYPE'].includes(match[1]))
          .slice(0, 12)
          .map((match) => `${match[1]}=${match[2] ?? ''}`);
        return `${String(source.length)}:${names.join('+')}`;
      });
      linkedPrograms.push(labels.join('/'));
      return nativeLinkProgram.call(this, program);
    };
    Object.defineProperty(globalThis, '__solarVoyagerLinkedPrograms', {
      value: linkedPrograms,
    });
  });
  const requestedCriticalFiles = new Set();
  const criticalResponses = [];
  let startupReady = false;
  let releaseStar;
  let reportStarSeen;
  const starRelease = new Promise((resolve) => {
    releaseStar = resolve;
  });
  const starSeen = new Promise((resolve) => {
    reportStarSeen = resolve;
  });
  page.on('request', (request) => {
    if (startupReady) return;
    const criticalFile = criticalFileFor(request.url());
    if (criticalFile !== null) requestedCriticalFiles.add(criticalFile);
  });
  page.on('response', (response) => {
    if (startupReady) return;
    const path = criticalFileFor(response.url());
    if (path !== null) criticalResponses.push({ path, status: response.status() });
  });
  await page.route(/\/assets\/stars-[^/]+\.bin$/u, async (route) => {
    reportStarSeen();
    await starRelease;
    await route.continue();
  });

  try {
    const navigation = page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });
    await starSeen;
    const loading = await page.locator('#startup-loading').evaluate((element) => ({
      ariaBusy: element.getAttribute('aria-busy'),
      role: element.getAttribute('role'),
      stage: element.getAttribute('data-startup-stage'),
      visible: !element.hidden,
    }));
    assert.deepEqual(loading, {
      ariaBusy: 'true',
      role: 'status',
      stage: 'context',
      visible: true,
    });
    releaseStar();
    const response = await navigation;
    assert.ok(response?.ok(), `production page returned ${String(response?.status())}`);
    await waitForReady(page);
    startupReady = true;
    const ready = await readStartup(page);
    assert.equal(ready.stage, 'ready');
    assert.equal(ready.progress, 1);
    assert.equal(ready.errorCount, 0);
    assert.equal(ready.qualitySource, 'auto');
    assert.ok(ready.probeMeanMs >= 0);
    assert.ok([0, 7, 14].includes(ready.selectedRung));
    assert.ok(ready.firstPlayableMs > 0 && ready.firstPlayableMs <= FIRST_PLAYABLE_CEILING_MS);
    assert.ok(ready.transferBytes > 0);
    assert.ok(ready.encodedBodyBytes > 0);
    assert.ok(ready.resourceCount > 0);
    assert.ok(ready.programCountAtReady > 0);
    assert.equal(ready.programCountCurrent, ready.programCountAtReady);
    assert.equal(ready.frozen, true);
    assert.equal(ready.nullPrototype, true);
    assert.equal(ready.readOnly, true);
    assert.deepEqual([...requestedCriticalFiles].sort(), [...EXPECTED_CRITICAL_FILES].sort());
    const criticalResourceMetrics = await page.evaluate(() =>
      globalThis.performance
        .getEntriesByType('resource')
        .map((entry) => ({
          encodedBodyBytes: entry.encodedBodySize,
          transferBytes: entry.transferSize,
          url: entry.name,
        })),
    );
    const metricsByPath = new Map();
    for (const metric of criticalResourceMetrics) {
      const path = criticalFileFor(metric.url);
      if (path === null) continue;
      const metrics = metricsByPath.get(path) ?? [];
      metrics.push(metric);
      metricsByPath.set(path, metrics);
    }
    const criticalRequests = criticalResponses
      .map((response) => {
        const metric = metricsByPath.get(response.path)?.shift();
        assert.ok(metric !== undefined, `resource timing missing for ${response.path}`);
        return {
          encodedBodyBytes: metric.encodedBodyBytes,
          path: response.path,
          status: response.status,
          transferBytes: metric.transferBytes,
        };
      })
      .sort((left, right) => left.path.localeCompare(right.path));
    assert.equal(criticalRequests.length, EXPECTED_CRITICAL_FILES.length);
    for (const request of criticalRequests) {
      assert.equal(request.status, 200, `${request.path} returned ${String(request.status)}`);
      assert.ok(request.encodedBodyBytes > 0, `${request.path} encoded no response body`);
      assert.ok(request.transferBytes > 0, `${request.path} transferred no response bytes`);
    }
    assert.equal(await page.locator('#startup-loading').evaluate((element) => element.hidden), true);
    const linkedProgramCountAtReady = await page.evaluate(
      () => globalThis.__solarVoyagerLinkedPrograms.length,
    );

    await page.getByRole('button', { name: 'New Game', exact: true }).click();
    await page.waitForFunction(
      () => {
        const canvas = globalThis.document.querySelector('#space-canvas');
        return (
          canvas instanceof globalThis.HTMLCanvasElement &&
          canvas.dataset.cameraReady === 'true' &&
          canvas.solarVoyagerTelemetry?.frameSampleCount > 0
        );
      },
      undefined,
      { timeout: 30_000 },
    );
    const afterFirstFrame = await readStartup(page);
    const firstFrameProgramLabels = await page.evaluate(
      (readyCount) => globalThis.__solarVoyagerLinkedPrograms.slice(readyCount),
      linkedProgramCountAtReady,
    );
    assert.equal(
      afterFirstFrame.programCountAfterFirstFrame,
      afterFirstFrame.programCountAtReady,
      `first ordinary frame compiled eager shaders: ${firstFrameProgramLabels.join(', ')}`,
    );
    assert.deepEqual(errors, { consoleErrors: [], pageErrors: [] });
    return {
      criticalRequests,
      encodedBodyBytes: ready.encodedBodyBytes,
      depthStrategy: ready.depthStrategy,
      devicePixelRatio: ready.devicePixelRatio,
      errors: { consoleErrors: [...errors.consoleErrors], pageErrors: [...errors.pageErrors] },
      firstPlayableMs: ready.firstPlayableMs,
      probeMeanMs: ready.probeMeanMs,
      programCountAfterFirstFrame: afterFirstFrame.programCountAfterFirstFrame,
      programCountAtReady: ready.programCountAtReady,
      requestedCriticalFiles: [...requestedCriticalFiles].sort(),
      resourceCount: ready.resourceCount,
      rendererName: ready.rendererName,
      selectedRung: ready.selectedRung,
      softwareRasterizer: ready.softwareRasterizer,
      transferBytes: ready.transferBytes,
    };
  } finally {
    releaseStar?.();
    await context.close();
  }
}

async function runManualBypass(browser) {
  const context = await browser.newContext({ viewport: { width: 1_280, height: 720 } });
  const page = await context.newPage();
  const errors = collectBrowserErrors(page);
  await installHighQualitySetting(page);
  try {
    await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });
    await waitForReady(page);
    const ready = await readStartup(page);
    assert.equal(ready.qualitySource, 'manual');
    assert.equal(ready.probeMeanMs, null);
    assert.equal(ready.selectedRung, 0);
    assert.deepEqual(errors, { consoleErrors: [], pageErrors: [] });
    return {
      errors: { consoleErrors: [...errors.consoleErrors], pageErrors: [...errors.pageErrors] },
      probeMeanMs: ready.probeMeanMs,
      selectedRung: ready.selectedRung,
    };
  } finally {
    await context.close();
  }
}

async function runRecoverableManifestFailure(browser) {
  const context = await browser.newContext({ viewport: { width: 640, height: 360 } });
  const page = await context.newPage();
  const errors = collectBrowserErrors(page);
  let manifestAttempts = 0;
  await page.route('**/assets/manifest.json', async (route) => {
    manifestAttempts += 1;
    if (manifestAttempts === 1) await route.abort('failed');
    else await route.continue();
  });
  try {
    await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });
    await page.locator('#startup-retry').waitFor({ state: 'visible', timeout: 30_000 });
    const failed = await readStartup(page);
    assert.equal(failed.stage, 'failed');
    assert.equal(failed.failedStage, 'star-catalog');
    assert.equal(failed.errorCount, 1);
    assert.ok(failed.errorMessage !== null && failed.errorMessage.length > 0);
    assert.ok(failed.errorMessage.length <= 160);
    assert.equal(await page.locator('#startup-loading').getAttribute('role'), 'alert');
    assert.deepEqual(errors.pageErrors, []);

    await page.locator('#startup-retry').click();
    await waitForReady(page);
    assert.equal(manifestAttempts, 2);
    assert.equal((await readStartup(page)).errorCount, 0);
    assert.deepEqual(errors.pageErrors, []);
    return {
      errors: { consoleErrors: [...errors.consoleErrors], pageErrors: [...errors.pageErrors] },
      failedStage: failed.failedStage,
      manifestAttempts,
    };
  } finally {
    await context.close();
  }
}

async function runRecoverableHeroFailure(browser) {
  const context = await browser.newContext({ viewport: { width: 640, height: 360 } });
  const page = await context.newPage();
  const errors = collectBrowserErrors(page);
  let textureAttempts = 0;
  await page.route('**/assets/textures/earth_albedo_tier2.ktx2', async (route) => {
    textureAttempts += 1;
    if (textureAttempts === 1) await route.abort('failed');
    else await route.continue();
  });
  try {
    await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });
    await page.locator('#startup-retry').waitFor({ state: 'visible', timeout: 30_000 });
    const failed = await readStartup(page);
    assert.equal(failed.stage, 'failed');
    assert.equal(failed.failedStage, 'asset-manifest');
    assert.equal(failed.errorCount, 1);
    assert.equal(await page.locator('#startup-loading').getAttribute('role'), 'alert');
    assert.deepEqual(errors.pageErrors, []);

    await page.locator('#startup-retry').click();
    await waitForReady(page);
    assert.equal(textureAttempts, 2);
    assert.equal((await readStartup(page)).errorCount, 0);
    assert.deepEqual(errors.pageErrors, []);
    return {
      errors: { consoleErrors: [...errors.consoleErrors], pageErrors: [...errors.pageErrors] },
      failedStage: failed.failedStage,
      textureAttempts,
    };
  } finally {
    await context.close();
  }
}

async function runRecoverableBootstrapFailure(browser) {
  const context = await browser.newContext({ viewport: { width: 640, height: 360 } });
  const page = await context.newPage();
  const errors = collectBrowserErrors(page);
  let chunkAttempts = 0;
  await page.route('**/assets/burnLogRuntime-*.js', async (route) => {
    chunkAttempts += 1;
    if (chunkAttempts === 1) await route.abort('failed');
    else await route.continue();
  });
  try {
    await page.goto(PAGE_URL, { waitUntil: 'commit' });
    await page.locator('#startup-retry').waitFor({ state: 'visible', timeout: 30_000 });
    const failed = await readStartup(page);
    assert.equal(failed.stage, 'failed');
    assert.equal(failed.failedStage, 'boot');
    assert.equal(failed.errorCount, 1);
    assert.equal(await page.locator('#startup-loading').getAttribute('role'), 'alert');
    assert.deepEqual(errors.pageErrors, []);

    await page.locator('#startup-retry').click();
    await waitForReady(page);
    assert.equal(chunkAttempts, 2);
    assert.equal((await readStartup(page)).errorCount, 0);
    assert.deepEqual(errors.pageErrors, []);
    return {
      chunkAttempts,
      errors: { consoleErrors: [...errors.consoleErrors], pageErrors: [...errors.pageErrors] },
      failedStage: failed.failedStage,
    };
  } finally {
    await context.close();
  }
}

async function main() {
  await assertPortAvailable(PORT, HOST);
  const server = await preview({
    root: process.cwd(),
    base: '/solar-voyager/',
    logLevel: 'error',
    preview: { host: HOST, port: PORT, strictPort: true },
  });
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const coldLoad = await runColdLoad(browser);
    const manualBypass = await runManualBypass(browser);
    const recoverableManifestFailure = await runRecoverableManifestFailure(browser);
    const recoverableHeroFailure = await runRecoverableHeroFailure(browser);
    const recoverableBootstrapFailure = await runRecoverableBootstrapFailure(browser);
    process.stdout.write(
      `${JSON.stringify(
        {
          environment: {
            browser: browser.version(),
            ci: process.env.CI === 'true',
            node: process.version,
            platform: process.platform,
          },
          coldLoad,
          manualBypass,
          recoverableBootstrapFailure,
          recoverableHeroFailure,
          recoverableManifestFailure,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    await browser?.close();
    await server.close();
  }
}

await main();
