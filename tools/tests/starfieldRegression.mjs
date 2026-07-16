import assert from 'node:assert/strict';

import { chromium } from 'playwright';
import { createServer } from 'vite';

const HOST = '127.0.0.1';
const PORT = 4178;
const FIXTURE_URL = `http://${HOST}:${PORT}/solar-voyager/tests/render/starfield.html`;
const ORIGIN = { x: 0, y: 0, z: 0 };
const WARP_POSITION = { x: 8.4e12, y: -3.2e12, z: 1.7e13 };
const MAX_PEAK_ERROR_PX = 2;

function assertObservedPeak(sample, label) {
  assert.ok(
    sample.litPixels > 0 && sample.peakRgb > 0,
    `${label}: ${sample.name} is absent at its catalog projection`,
  );
  assert.notEqual(sample.peakX, null, `${label}: ${sample.name} has no rendered peak X`);
  assert.notEqual(sample.peakY, null, `${label}: ${sample.name} has no rendered peak Y`);
  const errorPx = Math.hypot(sample.peakX - sample.x, sample.peakY - sample.y);
  assert.ok(
    errorPx <= MAX_PEAK_ERROR_PX,
    `${label}: ${sample.name} rendered peak is ${errorPx.toFixed(3)} px from projection`,
  );
}

function assertOrionDetected(snapshot, label) {
  assert.equal(snapshot.glError, 0, `${label}: WebGL error ${snapshot.glError}`);
  assert.equal(snapshot.drawCalls, 1, `${label}: starfield must use one draw call`);
  assert.ok(
    snapshot.totalLitPixels > snapshot.samples.length,
    `${label}: starfield is unexpectedly dark`,
  );
  for (const sample of snapshot.samples) assertObservedPeak(sample, label);
}

function assertBeltAlignment(samples, label) {
  const byName = new Map(samples.map((sample) => [sample.name, sample]));
  const mintaka = byName.get('Mintaka');
  const alnilam = byName.get('Alnilam');
  const alnitak = byName.get('Alnitak');
  assert.ok(mintaka && alnilam && alnitak, `${label}: Orion belt samples are incomplete`);
  assert.notEqual(mintaka.peakX, null);
  assert.notEqual(mintaka.peakY, null);
  assert.notEqual(alnilam.peakX, null);
  assert.notEqual(alnilam.peakY, null);
  assert.notEqual(alnitak.peakX, null);
  assert.notEqual(alnitak.peakY, null);
  const beltX = alnitak.peakX - mintaka.peakX;
  const beltY = alnitak.peakY - mintaka.peakY;
  const beltLengthSquared = beltX * beltX + beltY * beltY;
  const position =
    ((alnilam.peakX - mintaka.peakX) * beltX +
      (alnilam.peakY - mintaka.peakY) * beltY) /
    beltLengthSquared;
  const cross =
    ((alnilam.peakX - mintaka.peakX) * beltY -
      (alnilam.peakY - mintaka.peakY) * beltX) /
    Math.sqrt(beltLengthSquared);
  assert.ok(position > 0 && position < 1, `${label}: Alnilam is outside the rendered belt`);
  assert.ok(Math.abs(cross) < 3, `${label}: rendered belt bends by ${cross.toFixed(3)} px`);
}

async function runDepthMode(page, depthMode) {
  await page.goto(`${FIXTURE_URL}?depth=${depthMode}`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => globalThis.__starfieldHarness !== undefined);

  const darkControl = await page.evaluate(() => globalThis.__starfieldHarness.renderDarkControl());
  assert.equal(darkControl.totalLitPixels, 0, `${depthMode}: hidden control is not dark`);
  assert.equal(darkControl.drawCalls, 0, `${depthMode}: hidden control emitted a draw call`);
  assert.equal(
    darkControl.reversedDepthBuffer,
    depthMode === 'reversed',
    `${depthMode}: requested depth strategy is unavailable`,
  );

  const baseline = await page.evaluate(
    ([fov, position]) => globalThis.__starfieldHarness.render(fov, position),
    [60, ORIGIN],
  );
  assertOrionDetected(baseline, `${depthMode} baseline`);

  const isolatedOrion = await page.evaluate(() =>
    globalThis.__starfieldHarness.renderIsolatedOrion(),
  );
  for (const sample of isolatedOrion) assertObservedPeak(sample, `${depthMode} isolated`);
  assertBeltAlignment(isolatedOrion, `${depthMode} isolated`);

  const occluded = await page.evaluate(() =>
    globalThis.__starfieldHarness.renderOcclusionControl(),
  );
  const alnilam = occluded.samples.find((sample) => sample.name === 'Alnilam');
  assert.ok(alnilam, `${depthMode}: missing Alnilam occlusion sample`);
  assert.equal(alnilam.litPixels, 0, `${depthMode}: foreground body did not occlude Alnilam`);
  assert.equal(occluded.drawCalls, 2, `${depthMode}: occlusion control draw count changed`);

  const warped = await page.evaluate(
    ([fov, position]) => globalThis.__starfieldHarness.render(fov, position),
    [60, WARP_POSITION],
  );
  assertOrionDetected(warped, `${depthMode} warp`);
  assert.equal(warped.frameHash, baseline.frameHash, `${depthMode}: warp changed star pixels`);
  assert.deepEqual(warped.samples, baseline.samples, `${depthMode}: warp moved Orion`);

  const zoomed = await page.evaluate(
    ([fov, position]) => globalThis.__starfieldHarness.render(fov, position),
    [35, WARP_POSITION],
  );
  assertOrionDetected(zoomed, `${depthMode} zoom`);
  assert.notEqual(zoomed.frameHash, baseline.frameHash, `${depthMode}: zoom did not reframe`);

  return {
    depthMode,
    reversedDepthBuffer: baseline.reversedDepthBuffer,
    baselineHash: baseline.frameHash,
    warpedHash: warped.frameHash,
    zoomedHash: zoomed.frameHash,
    baselineLitPixels: baseline.totalLitPixels,
    zoomedLitPixels: zoomed.totalLitPixels,
    occludedAlnilamPixels: alnilam.litPixels,
    isolatedPeakRgb: Object.fromEntries(
      isolatedOrion.map((sample) => [sample.name, sample.peakRgb]),
    ),
  };
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
  browser = await chromium.launch({
    headless: true,
    args: ['--enable-webgl', '--ignore-gpu-blocklist'],
  });
  const page = await browser.newPage({ viewport: { width: 384, height: 384 } });
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  const logarithmic = await runDepthMode(page, 'logarithmic');
  const reversed = await runDepthMode(page, 'reversed');

  assert.deepEqual(pageErrors, []);
  assert.deepEqual(consoleErrors, []);
  process.stdout.write(`${JSON.stringify({ logarithmic, reversed }, null, 2)}\n`);
} finally {
  if (browser !== undefined) await browser.close();
  await server.close();
}
