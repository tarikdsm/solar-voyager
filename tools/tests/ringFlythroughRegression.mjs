import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { chromium } from 'playwright';
import { createServer } from 'vite';

const HOST = '127.0.0.1';
const PORT = 4186;
const FIXTURE_URL = `http://${HOST}:${PORT}/solar-voyager/tests/render/ringFlythrough.html`;

const server = await createServer({
  root: process.cwd(),
  base: '/solar-voyager/',
  logLevel: 'error',
  server: { host: HOST, port: PORT, strictPort: true },
});
let browser;

try {
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    args: [
      '--enable-webgl',
      '--ignore-gpu-blocklist',
      '--enable-precise-memory-info',
      '--js-flags=--expose-gc',
    ],
  });
  const page = await browser.newPage({ viewport: { width: 512, height: 512 } });
  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('requestfailed', (request) => failedRequests.push(request.url()));

  await page.goto(FIXTURE_URL, { waitUntil: 'networkidle', timeout: 120_000 });
  await page.waitForFunction(() => globalThis.__ringFlythroughTest !== undefined, undefined, {
    timeout: 120_000,
  });
  const programs = await page.evaluate(() => globalThis.__ringFlythroughTest.programs);
  assert.ok(
    programs.afterPrecompile > programs.beforePrecompile,
    `particle program was not precompiled: ${JSON.stringify(programs)}`,
  );
  assert.equal(
    programs.afterFirstActive,
    programs.afterPrecompile,
    'first particle activation compiled a runtime program',
  );
  assert.equal(programs.afterWarmUp, programs.afterFirstActive, 'particle program changed after warm-up');

  const baseline = await page.evaluate(() => globalThis.__ringFlythroughTest.sample(0, 0, 0));
  const active = await page.evaluate(() => globalThis.__ringFlythroughTest.sample(0, 0, 4096));
  assert.equal(baseline.glError, 0);
  assert.equal(active.glError, 0);
  assert.equal(active.calls, baseline.calls + 1, 'particle field must add exactly one draw call');

  const qualityCounts = [];
  for (const count of [4096, 2048, 1024, 0]) {
    const snapshot = await page.evaluate(
      (cap) => globalThis.__ringFlythroughTest.sample(0, 1, cap),
      count,
    );
    qualityCounts.push(snapshot.count);
  }
  assert.deepEqual(qualityCounts, [4096, 2048, 1024, 0]);

  const heights = [2600, 1800, 1200, 600, 0, -600, -1200, -1800, -2600];
  const crossing = [];
  const crossingLayers = [];
  for (const height of heights) {
    const combined = await page.evaluate(
      (value) => globalThis.__ringFlythroughTest.sample(value, 2, 4096, 'combined'),
      height,
    );
    const annulus = await page.evaluate(
      (value) => globalThis.__ringFlythroughTest.sample(value, 2, 4096, 'annulus'),
      height,
    );
    const particles = await page.evaluate(
      (value) => globalThis.__ringFlythroughTest.sample(value, 2, 4096, 'particles'),
      height,
    );
    const strongestLayerPixels = Math.max(annulus.litPixels, particles.litPixels, 1);
    const strongestLayerLuminance = Math.max(
      annulus.meanLuminance,
      particles.meanLuminance,
      Number.EPSILON,
    );
    crossing.push(combined);
    crossingLayers.push({
      annulus,
      combined,
      coverageRatio: combined.litPixels / strongestLayerPixels,
      luminanceRatio: combined.meanLuminance / strongestLayerLuminance,
      particles,
    });
  }
  assert.equal(crossing[0].blend, 0);
  assert.equal(crossing.at(-1).blend, 0);
  assert.equal(crossing[4].blend, 1);
  for (let index = 1; index < 4; index += 1) {
    assert.ok(crossing[index].blend > crossing[index - 1].blend, 'blend did not rise smoothly');
    assert.ok(
      Math.abs(crossing[index].blend - crossing[heights.length - 1 - index].blend) < 1e-12,
      'plane crossing is asymmetric',
    );
  }
  assert.ok(
    crossingLayers.every(
      (snapshot) => snapshot.coverageRatio >= 0.95 && snapshot.luminanceRatio >= 0.65,
    ),
    `rendered cross-fade contains a visual gap: ${JSON.stringify(crossingLayers)}`,
  );

  const particlesBefore = await page.evaluate(() =>
    globalThis.__ringFlythroughTest.sample(0.02, 0, 4096, 'particles'),
  );
  const particlesAfter = await page.evaluate(() =>
    globalThis.__ringFlythroughTest.sample(0.02, 0.001, 4096, 'particles'),
  );
  const diagnostics = await page.evaluate(() => globalThis.__ringFlythroughTest.diagnostics());
  assert.ok(
    particlesBefore.litPixels > 0,
    `particle flythrough is dark: ${JSON.stringify({ particlesBefore, diagnostics })}`,
  );
  assert.ok(particlesAfter.litPixels > 0, `moving particle frame is dark: ${JSON.stringify(particlesAfter)}`);
  assert.notEqual(particlesAfter.pixelHash, particlesBefore.pixelHash, 'particle pixels did not move');
  assert.ok(
    Math.hypot(
      particlesAfter.centroidX - particlesBefore.centroidX,
      particlesAfter.centroidY - particlesBefore.centroidY,
    ) > 0.01,
    'particle centroid lacks parallax motion',
  );

  const stressWarmUp = await page.evaluate(() => globalThis.__ringFlythroughTest.stress(50_000));
  const stress = await page.evaluate(() => globalThis.__ringFlythroughTest.stress(50_000));
  assert.ok(stress.blend > 0.99);
  if (stress.heapDeltaBytes !== null) {
    assert.ok(stress.heapDeltaBytes <= 65_536, `ring update heap grew: ${stress.heapDeltaBytes}`);
  }
  assert.deepEqual(failedRequests, []);
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(consoleErrors, []);

  if (process.env.RING_FLYTHROUGH_SCREENSHOTS !== undefined) {
    const output = resolve(process.env.RING_FLYTHROUGH_SCREENSHOTS);
    await mkdir(output, { recursive: true });
    await page.evaluate(() => globalThis.__ringFlythroughTest.sample(0.02, 0, 4096, 'particles'));
    await writeFile(resolve(output, 'saturn-particles-before.png'), await page.locator('canvas').screenshot());
    await page.evaluate(() =>
      globalThis.__ringFlythroughTest.sample(0.02, 0.001, 4096, 'particles'),
    );
    await writeFile(resolve(output, 'saturn-particles-after.png'), await page.locator('canvas').screenshot());
  }
  process.stdout.write(
    `${JSON.stringify({ programs, qualityCounts, crossing, crossingLayers, particlesBefore, particlesAfter, diagnostics, stressWarmUp, stress }, null, 2)}\n`,
  );
} finally {
  if (browser !== undefined) await browser.close();
  await server.close();
}
