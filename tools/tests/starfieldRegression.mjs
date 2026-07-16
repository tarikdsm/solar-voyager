import assert from 'node:assert/strict';

import { chromium } from 'playwright';
import { createServer } from 'vite';

const HOST = '127.0.0.1';
const PORT = 4178;
const FIXTURE_URL = `http://${HOST}:${PORT}/solar-voyager/tests/render/starfield.html`;
const ORIGIN = { x: 0, y: 0, z: 0 };
const WARP_POSITION = { x: 8.4e12, y: -3.2e12, z: 1.7e13 };

function assertOrionDetected(snapshot, label) {
  assert.equal(snapshot.glError, 0, `${label}: WebGL error ${snapshot.glError}`);
  assert.equal(snapshot.drawCalls, 1, `${label}: starfield must use one draw call`);
  assert.ok(
    snapshot.totalLitPixels > snapshot.samples.length,
    `${label}: starfield is unexpectedly dark`,
  );
  for (const sample of snapshot.samples) {
    assert.ok(
      sample.litPixels > 0 && sample.peakRgb > 0,
      `${label}: ${sample.name} is absent at its catalog projection`,
    );
  }
}

function assertBeltAlignment(snapshot) {
  const byName = new Map(snapshot.samples.map((sample) => [sample.name, sample]));
  const mintaka = byName.get('Mintaka');
  const alnilam = byName.get('Alnilam');
  const alnitak = byName.get('Alnitak');
  assert.ok(mintaka && alnilam && alnitak, 'Orion belt samples are incomplete');
  const beltX = alnitak.x - mintaka.x;
  const beltY = alnitak.y - mintaka.y;
  const beltLengthSquared = beltX * beltX + beltY * beltY;
  const position =
    ((alnilam.x - mintaka.x) * beltX + (alnilam.y - mintaka.y) * beltY) /
    beltLengthSquared;
  const cross =
    ((alnilam.x - mintaka.x) * beltY - (alnilam.y - mintaka.y) * beltX) /
    Math.sqrt(beltLengthSquared);
  assert.ok(position > 0 && position < 1, 'Alnilam is not between Mintaka and Alnitak');
  assert.ok(Math.abs(cross) < 2, `Orion belt is not aligned: ${cross.toFixed(3)} px`);
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

  await page.goto(FIXTURE_URL, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => globalThis.__starfieldHarness !== undefined);

  const darkControl = await page.evaluate(() => globalThis.__starfieldHarness.renderDarkControl());
  assert.equal(darkControl.totalLitPixels, 0, 'hidden-starfield control is not dark');
  assert.equal(darkControl.drawCalls, 0, 'hidden-starfield control emitted a draw call');

  const baseline = await page.evaluate(
    ([fov, position]) => globalThis.__starfieldHarness.render(fov, position),
    [60, ORIGIN],
  );
  assertOrionDetected(baseline, 'baseline');
  assertBeltAlignment(baseline);

  const warped = await page.evaluate(
    ([fov, position]) => globalThis.__starfieldHarness.render(fov, position),
    [60, WARP_POSITION],
  );
  assertOrionDetected(warped, 'warp');
  assert.equal(warped.frameHash, baseline.frameHash, 'warp translation changed star pixels');
  assert.deepEqual(warped.samples, baseline.samples, 'warp translation moved Orion projections');

  const zoomed = await page.evaluate(
    ([fov, position]) => globalThis.__starfieldHarness.render(fov, position),
    [35, WARP_POSITION],
  );
  assertOrionDetected(zoomed, 'zoom');
  assert.notEqual(zoomed.frameHash, baseline.frameHash, 'zoom did not change angular framing');
  assertBeltAlignment(zoomed);

  assert.deepEqual(pageErrors, []);
  assert.deepEqual(consoleErrors, []);
  process.stdout.write(
    `${JSON.stringify({ darkControl, baseline, warped, zoomed }, null, 2)}\n`,
  );
} finally {
  if (browser !== undefined) await browser.close();
  await server.close();
}
