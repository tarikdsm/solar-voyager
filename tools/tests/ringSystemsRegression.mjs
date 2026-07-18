import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { chromium } from 'playwright';
import { createServer } from 'vite';

const HOST = '127.0.0.1';
const PORT = 4185;
const FIXTURE_URL = `http://${HOST}:${PORT}/solar-voyager/tests/render/ringSystems.html`;
const BODY_IDS = ['jupiter', 'saturn', 'uranus', 'neptune'];

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
  const page = await browser.newPage({ viewport: { width: 512, height: 512 } });
  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];
  const requests = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('request', (request) => requests.push(request.url()));
  page.on('requestfailed', (request) => failedRequests.push(request.url()));

  await page.goto(FIXTURE_URL, { waitUntil: 'networkidle', timeout: 120_000 });
  await page.waitForFunction(() => globalThis.__ringSystemsTest !== undefined, undefined, {
    timeout: 120_000,
  });
  const setup = await page.evaluate(() => ({
    loadedBodyIds: globalThis.__ringSystemsTest.loadedBodyIds,
    programs: globalThis.__ringSystemsTest.programs,
  }));
  assert.deepEqual(setup.loadedBodyIds, BODY_IDS);
  assert.ok(setup.programs.afterFirstPass > setup.programs.beforeWarmUp);
  assert.equal(setup.programs.afterWarmUp, setup.programs.afterFirstPass);

  const snapshots = [];
  for (const bodyId of BODY_IDS) {
    for (const mode of ['top', 'shadow', 'backlit', 'edge']) {
      const snapshot = await page.evaluate(
        ([id, view]) => globalThis.__ringSystemsTest.render(id, view),
        [bodyId, mode],
      );
      assert.equal(snapshot.glError, 0, `${bodyId}/${mode}: WebGL error`);
      assert.ok(
        snapshot.litPixels > (mode === 'edge' ? 25 : 250),
        `${bodyId}/${mode}: dark frame ${JSON.stringify(snapshot)}`,
      );
      assert.ok(snapshot.calls >= 2, `${bodyId}/${mode}: missing planet/ring draws`);
      assert.ok(snapshot.triangles >= 18_176, `${bodyId}/${mode}: incomplete model topology`);
      snapshots.push(snapshot);
    }
  }
  const saturnPlanetShadow = await page.evaluate(() =>
    globalThis.__ringSystemsTest.render('saturn', 'planet-shadow'),
  );
  const saturnPlanetControl = await page.evaluate(() =>
    globalThis.__ringSystemsTest.render('saturn', 'planet-shadow-control'),
  );
  if (process.env.RING_SYSTEM_SCREENSHOTS !== undefined) {
    const output = resolve(process.env.RING_SYSTEM_SCREENSHOTS);
    await mkdir(output, { recursive: true });
    await writeFile(
      resolve(output, 'saturn-planet-shadow.png'),
      await page.locator('canvas').screenshot(),
    );
  }
  assert.equal(saturnPlanetShadow.glError, 0, 'Saturn planet-shadow: WebGL error');
  assert.equal(saturnPlanetControl.glError, 0, 'Saturn planet-shadow control: WebGL error');
  assert.ok(
    saturnPlanetShadow.planetDiskPixels > 1_000,
    `Saturn planet disk sample is empty: ${JSON.stringify(saturnPlanetShadow)}`,
  );
  assert.ok(
    saturnPlanetShadow.planetDiskMean < saturnPlanetControl.planetDiskMean * 0.995,
    `Saturn ring shadow is absent from the planet: ${JSON.stringify({ saturnPlanetControl, saturnPlanetShadow })}`,
  );
  snapshots.push(saturnPlanetShadow, saturnPlanetControl);

  for (const bodyId of BODY_IDS) {
    const top = snapshots.find((snapshot) => snapshot.bodyId === bodyId && snapshot.mode === 'top');
    const shadow = snapshots.find(
      (snapshot) => snapshot.bodyId === bodyId && snapshot.mode === 'shadow',
    );
    const backlit = snapshots.find(
      (snapshot) => snapshot.bodyId === bodyId && snapshot.mode === 'backlit',
    );
    assert.ok(top.annulusMean > 0.1, `${bodyId}: annulus is invisible`);
    assert.ok(top.radialVariation > 0.05, `${bodyId}: radial structure is flat`);
    assert.ok(shadow.angularContrast > 1.04, `${bodyId}: planet-shadow sector is absent`);
    assert.ok(
      backlit.annulusMean > 0.005,
      `${bodyId}: backlit rings vanished ${JSON.stringify(backlit)}`,
    );
    assert.ok(
      backlit.annulusMean < top.annulusMean * 1.75 + 1,
      `${bodyId}: transmitted light is unbounded`,
    );
  }
  const neptuneTop = snapshots.find(
    (snapshot) => snapshot.bodyId === 'neptune' && snapshot.mode === 'top',
  );
  assert.ok(
    neptuneTop.arcBandAngularContrast > 1.15,
    `Neptune Adams arcs are not localized: ${JSON.stringify(neptuneTop)}`,
  );
  assert.ok(
    neptuneTop.innerBandAngularContrast < 1.12,
    `Neptune arcs leaked into inner rings: ${JSON.stringify(neptuneTop)}`,
  );

  for (const bodyId of BODY_IDS) {
    const modelRequests = requests.filter((url) =>
      new URL(url).pathname.endsWith(`/models/${bodyId}.glb`),
    );
    assert.equal(modelRequests.length, 1, `${bodyId}: unexpected canonical model requests`);
  }
  assert.deepEqual(failedRequests, []);
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(consoleErrors, []);

  if (process.env.RING_SYSTEM_SCREENSHOTS !== undefined) {
    const output = resolve(process.env.RING_SYSTEM_SCREENSHOTS);
    await mkdir(output, { recursive: true });
    for (const bodyId of BODY_IDS) {
      await page.evaluate((id) => globalThis.__ringSystemsTest.render(id, 'shadow'), bodyId);
      await writeFile(resolve(output, `${bodyId}-shadow.png`), await page.locator('canvas').screenshot());
    }
  }
  process.stdout.write(`${JSON.stringify({ programs: setup.programs, snapshots }, null, 2)}\n`);
} finally {
  if (browser !== undefined) await browser.close();
  await server.close();
}
