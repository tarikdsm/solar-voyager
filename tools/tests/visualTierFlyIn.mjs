import assert from 'node:assert/strict';

import { chromium } from 'playwright';
import { createServer } from 'vite';

const HOST = '127.0.0.1';
const PORT = 4177;
const FIXTURE_URL = `http://${HOST}:${PORT}/solar-voyager/tests/render/visualTierFlyIn.html`;
const AU_KM = 149_597_870.7;
const EARTH_LEO_CENTER_KM = 6_371.0084 + 400;
const EARTH_POINT_EXIT_KM = 3_000_000;
const PLUTO_APPROACH_KM = 1_188.3 + 400;

function assertVisible(snapshot, label) {
  assert.equal(snapshot.glError, 0, `${label}: WebGL error ${snapshot.glError}`);
  assert.ok(snapshot.opacitySum > 0.999, `${label}: opacity sum fell below one`);
  assert.ok(
    snapshot.litPixels > 0,
    `${label}: rendered frame is dark (${JSON.stringify(snapshot)})`,
  );
}

function assetRequests(requests, pattern) {
  return requests.filter((url) => pattern.test(new URL(url).pathname));
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
  const page = await browser.newPage({ viewport: { width: 256, height: 256 } });
  const requests = [];
  const pageErrors = [];
  const consoleErrors = [];
  page.on('request', (request) => requests.push(request.url()));
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  await page.goto(FIXTURE_URL, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => globalThis.__visualTierHarness !== undefined);

  assert.equal(assetRequests(requests, /\/models\//u).length, 0, 'model fetched at startup');
  assert.equal(
    assetRequests(requests, /pluto_albedo(?:_(?:tier2|[12]k))?\.ktx2$/u).length,
    0,
    'non-hero sphere fetched at startup',
  );
  const darkControl = await page.evaluate(() =>
    globalThis.__visualTierHarness.renderEarthDarkControl(-100),
  );
  assert.equal(
    darkControl.litPixels,
    0,
    `target-isolation control rendered another body (${JSON.stringify(darkControl)})`,
  );

  const snapshots = [];
  async function stepEarth(distanceKm, nowMs, label) {
    const snapshot = await page.evaluate(
      ([distance, now]) => globalThis.__visualTierHarness.stepEarthDistance(distance, now),
      [distanceKm, nowMs],
    );
    assertVisible(snapshot, label);
    snapshots.push({ label, ...snapshot });
    return snapshot;
  }

  const point = await stepEarth(AU_KM, 0, 'earth point');
  assert.equal(point.tier, 1);
  await stepEarth(1_000_000, 100, 'point-sphere start');
  const pointSphereMid = await stepEarth(1_000_000, 225, 'point-sphere midpoint');
  assert.ok(pointSphereMid.pointOpacity > 0 && pointSphereMid.sphereOpacity > 0);
  const sphere = await stepEarth(1_000_000, 350, 'earth sphere');
  assert.equal(sphere.tier, 2);

  const loadingModel = await stepEarth(EARTH_LEO_CENTER_KM, 400, 'earth model loading');
  assert.equal(loadingModel.tier, 3);
  assert.equal(loadingModel.modelOpacity, 0);
  await page.waitForFunction(
    () => globalThis.__visualTierHarness.snapshotState('earth').loadState === 'ready',
    undefined,
    { timeout: 60_000 },
  );
  await stepEarth(EARTH_LEO_CENTER_KM, 500, 'sphere-model start');
  const sphereModelMid = await stepEarth(EARTH_LEO_CENTER_KM, 625, 'sphere-model midpoint');
  assert.ok(sphereModelMid.sphereOpacity > 0 && sphereModelMid.modelOpacity > 0);
  const model = await stepEarth(EARTH_LEO_CENTER_KM, 750, 'earth model');
  assert.equal(model.tier, 3);
  assert.equal(model.modelOpacity, 1);

  await stepEarth(1_000_000, 800, 'model-sphere start');
  const returningSphere = await stepEarth(1_000_000, 1_050, 'returning sphere');
  assert.equal(returningSphere.tier, 2);
  await stepEarth(EARTH_POINT_EXIT_KM, 1_100, 'sphere-point start');
  await stepEarth(EARTH_POINT_EXIT_KM, 1_225, 'sphere-point midpoint');
  const returningPoint = await stepEarth(AU_KM, 1_350, 'returning point');
  assert.equal(returningPoint.tier, 1);
  assert.deepEqual(
    [point.tier, sphere.tier, model.tier, returningSphere.tier, returningPoint.tier],
    [1, 2, 3, 2, 1],
  );

  assert.equal(
    assetRequests(requests, /pluto_albedo(?:_(?:tier2|[12]k))?\.ktx2$/u).length,
    0,
  );
  const pluto = await page.evaluate(
    ([distance, now]) => globalThis.__visualTierHarness.stepPlutoDistance(distance, now),
    [PLUTO_APPROACH_KM, 1_500],
  );
  assertVisible(pluto, 'pluto approach');
  await page.waitForFunction(
    () => globalThis.__visualTierHarness.snapshotState('pluto').loadState !== 'loading',
    undefined,
    { timeout: 60_000 },
  );
  const plutoReady = await page.evaluate(
    ([distance, now]) => globalThis.__visualTierHarness.stepPlutoDistance(distance, now),
    [PLUTO_APPROACH_KM, 1_750],
  );
  assertVisible(plutoReady, 'pluto ready');
  assert.equal(
    assetRequests(requests, /pluto_albedo\.ktx2$/u).length,
    2,
    'canonical Pluto albedo must serve both the lazy sphere and detailed model',
  );
  assert.equal(assetRequests(requests, /\/models\/pluto\.glb$/u).length, 1);
  assert.equal(assetRequests(requests, /\/models\/earth\.glb$/u).length, 1);

  assert.deepEqual(pageErrors, []);
  assert.deepEqual(consoleErrors, []);
  process.stdout.write(`${JSON.stringify({ snapshots, requestCount: requests.length }, null, 2)}\n`);
} finally {
  if (browser !== undefined) await browser.close();
  await server.close();
}
