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
// Both tiers are reachable at this distance thanks to the +-20% hysteresis
// band, so tier 2 and tier 3 can be measured from the identical camera pose.
const SATURN_SHARED_TIER_KM = 170_900;
const SATURN_MODEL_KM = 110_000;
const SATURN_SPHERE_KM = 400_000;
const SATURN_POLAR_RATIO = 0.9020375655405853;
const SATURN_REFERENCE_RADIUS_KM = 60_268;
const EARTH_SIDEREAL_SEC = 86_164.100_352;

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
    args: [
      '--enable-webgl',
      '--ignore-gpu-blocklist',
      '--enable-precise-memory-info',
      '--js-flags=--expose-gc',
    ],
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

  // ---------------------------------------------------------------- T0128
  // Sidereal rotation is published from simulation time, into every tier.
  const rotation = [];
  for (const [nowMs, simTimeSec] of [
    [2_000, 0],
    [2_100, EARTH_SIDEREAL_SEC / 4],
    [2_200, EARTH_SIDEREAL_SEC / 4],
    [2_300, EARTH_SIDEREAL_SEC / 2],
  ]) {
    const snapshot = await page.evaluate(
      ([distance, now, simTime]) =>
        globalThis.__visualTierHarness.stepEarthDistance(distance, now, simTime),
      [EARTH_LEO_CENTER_KM, nowMs, simTimeSec],
    );
    assertVisible(snapshot, `earth spin ${String(simTimeSec)}`);
    rotation.push(await page.evaluate(() => globalThis.__visualTierHarness.attitude('earth')));
  }
  for (const sample of rotation) {
    for (let component = 0; component < 4; component += 1) {
      assert.ok(
        Math.abs(sample.quaternion[component] - sample.expected[component]) < 1e-12,
        `published attitude drifted from the analytic value: ${JSON.stringify(sample)}`,
      );
      assert.ok(
        Math.abs(sample.sphereQuaternion[component] - sample.quaternion[component]) < 1e-12,
        `tier-2 sphere attitude is out of step: ${JSON.stringify(sample)}`,
      );
      assert.ok(
        Math.abs(sample.modelQuaternion[component] - sample.quaternion[component]) < 1e-12,
        `tier-3 model attitude is out of step: ${JSON.stringify(sample)}`,
      );
    }
  }
  assert.ok(
    Math.abs(rotation[1].spinAngleRad - rotation[0].spinAngleRad - Math.PI / 2) < 1e-9,
    `a quarter sidereal period is not a quarter turn: ${JSON.stringify(rotation.map((sample) => sample.spinAngleRad))}`,
  );
  // The wall clock advanced 100 ms between samples 1 and 2 while simulation time
  // did not: nothing may move. This is the landmine the clouds used to trip.
  assert.deepEqual(
    rotation[2].quaternion,
    rotation[1].quaternion,
    'body attitude followed the wall clock',
  );
  assert.equal(
    rotation[2].cloudRotationY,
    rotation[1].cloudRotationY,
    'Earth clouds followed the wall clock',
  );
  assert.ok(
    rotation[3].cloudRotationY !== rotation[2].cloudRotationY,
    'Earth clouds ignored simulation time',
  );

  // Tier-2 oblateness, and no silhouette pop across the 2<->3 boundary.
  const saturnRadii = await page.evaluate(() => globalThis.__visualTierHarness.radii('saturn'));
  assert.ok(
    Math.abs(saturnRadii.equatorialKm - SATURN_REFERENCE_RADIUS_KM) < 1e-6,
    `tier-2 Saturn does not use the ring reference radius: ${JSON.stringify(saturnRadii)}`,
  );
  assert.ok(
    Math.abs(saturnRadii.polarKm - SATURN_REFERENCE_RADIUS_KM * SATURN_POLAR_RATIO) < 1e-6,
    `tier-2 Saturn polar radius is wrong: ${JSON.stringify(saturnRadii)}`,
  );

  async function stepSaturn(distanceKm, nowMs, label) {
    const snapshot = await page.evaluate(
      ([distance, now]) => globalThis.__visualTierHarness.stepSaturnDistance(distance, now, 0),
      [distanceKm, nowMs],
    );
    assertVisible(snapshot, label);
    snapshots.push({ label, ...snapshot });
    return snapshot;
  }

  await stepSaturn(SATURN_MODEL_KM, 3_000, 'saturn model loading');
  await page.waitForFunction(
    () => globalThis.__visualTierHarness.snapshotState('saturn').loadState !== 'loading',
    undefined,
    { timeout: 120_000 },
  );
  await stepSaturn(SATURN_MODEL_KM, 3_100, 'saturn model fade start');
  const saturnModel = await stepSaturn(SATURN_MODEL_KM, 3_400, 'saturn model');
  assert.equal(saturnModel.tier, 3);
  assert.equal(saturnModel.modelOpacity, 1);

  // The rings are a tier-3-only representation; the silhouette question is about
  // the planet, so they are hidden for the measurement and restored after.
  await page.evaluate(() => globalThis.__visualTierHarness.setRingsVisible(false));
  await stepSaturn(SATURN_SHARED_TIER_KM, 3_500, 'saturn shared-distance model');
  const modelSilhouette = await page.evaluate(() => globalThis.__visualTierHarness.silhouette());
  await stepSaturn(SATURN_SPHERE_KM, 3_600, 'saturn model to sphere');
  await stepSaturn(SATURN_SPHERE_KM, 3_900, 'saturn sphere');
  const saturnSphere = await stepSaturn(
    SATURN_SHARED_TIER_KM,
    4_200,
    'saturn shared-distance sphere',
  );
  assert.equal(saturnSphere.tier, 2);
  assert.equal(saturnSphere.modelOpacity, 0);
  const sphereSilhouette = await page.evaluate(() => globalThis.__visualTierHarness.silhouette());
  await page.evaluate(() => globalThis.__visualTierHarness.setRingsVisible(true));

  const silhouettes = { modelSilhouette, sphereSilhouette };
  assert.ok(
    Math.abs(sphereSilhouette.axisRatio - SATURN_POLAR_RATIO) < 0.03,
    `tier-2 sphere is not oblate: ${JSON.stringify(silhouettes)}`,
  );
  assert.ok(
    Math.abs(modelSilhouette.axisRatio - sphereSilhouette.axisRatio) < 0.03,
    `flattening pops across the tier boundary: ${JSON.stringify(silhouettes)}`,
  );
  assert.ok(
    Math.abs(modelSilhouette.majorAxisPx - sphereSilhouette.majorAxisPx) /
      modelSilhouette.majorAxisPx <
      0.03,
    `equatorial silhouette pops across the tier boundary: ${JSON.stringify(silhouettes)}`,
  );
  assert.ok(
    Math.abs(modelSilhouette.area - sphereSilhouette.area) / modelSilhouette.area < 0.06,
    `silhouette area pops across the tier boundary: ${JSON.stringify(silhouettes)}`,
  );

  const stressWarmUp = await page.evaluate(() => globalThis.__visualTierHarness.stress(20_000));
  const stress = await page.evaluate(() => globalThis.__visualTierHarness.stress(20_000));
  if (stress.heapDeltaBytes !== null) {
    assert.ok(
      stress.heapDeltaBytes <= 65_536,
      `body visual update heap grew: ${stress.heapDeltaBytes}`,
    );
  }

  assert.deepEqual(pageErrors, []);
  assert.deepEqual(consoleErrors, []);
  process.stdout.write(`${JSON.stringify({ snapshots, rotation, saturnRadii, silhouettes, stressWarmUp, stress, requestCount: requests.length }, null, 2)}\n`);
} finally {
  if (browser !== undefined) await browser.close();
  await server.close();
}
