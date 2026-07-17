import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { chromium } from 'playwright';
import { createServer } from 'vite';

const HOST = '127.0.0.1';
const PORT = 4185;
const PAGE_URL = `http://${HOST}:${String(PORT)}/solar-voyager/tests/render/perfGovernor.html`;
const updateCommittedScreenshots = process.env.UPDATE_T0091_SCREENSHOTS === '1';
const screenshotDirectory = path.join(
  process.cwd(),
  updateCommittedScreenshots ? 'docs/bench/T0091-rungs' : '.playwright-mcp/T0091-rungs',
);

const server = await createServer({
  root: process.cwd(),
  base: '/solar-voyager/',
  logLevel: 'error',
  server: { host: HOST, port: PORT, strictPort: true },
});
let browser;

try {
  await mkdir(screenshotDirectory, { recursive: true });
  await server.listen();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 900, height: 360 } });
  const errors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  const response = await page.goto(PAGE_URL, { waitUntil: 'networkidle', timeout: 60_000 });
  assert.ok(response?.ok(), `fixture returned ${String(response?.status())}`);
  await page.waitForFunction(() => globalThis.__perfGovernorHarness !== undefined, undefined, {
    timeout: 60_000,
  });

  const programCountAfterWarmUp = await page.evaluate(
    () => globalThis.__perfGovernorHarness.programCountAfterWarmUp,
  );
  const snapshots = [];
  for (let rung = 0; rung < 15; rung += 1) {
    const snapshot = await page.evaluate(
      (selectedRung) => globalThis.__perfGovernorHarness.applyRung(selectedRung),
      rung,
    );
    snapshots.push(snapshot);
    await page.screenshot({
      path: path.join(screenshotDirectory, `rung-${String(rung).padStart(2, '0')}.png`),
    });
  }

  assert.deepEqual(
    snapshots.map(({ canvasWidth }) => canvasWidth),
    [640, 544, 448, ...Array.from({ length: 12 }, () => 352)],
  );
  assert.equal(snapshots[3].bloom, 'full');
  assert.ok(snapshots[4].bloomWidth < snapshots[3].bloomWidth);
  assert.equal(snapshots[5].bloom, 'off');
  assert.equal(snapshots[0].smaaEnabled, true);
  assert.equal(snapshots[6].fxaaEnabled, true);
  assert.equal(snapshots[7].smaaEnabled, false);
  assert.equal(snapshots[7].fxaaEnabled, false);
  assert.equal(snapshots[8].proceduralOctaves, 2);
  assert.equal(snapshots[9].proceduralOctaves, 1);
  assert.equal(snapshots[10].starCount, 4_000);
  assert.equal(snapshots[11].starCount, 2_000);
  assert.equal(snapshots[12].textureCap, '2k');
  assert.equal(snapshots[13].textureCap, '1k');
  assert.equal(snapshots[14].modelThresholdScale, 2);
  assert.equal(snapshots[14].earthTier, 2);
  assert.ok(
    snapshots.every(({ programCount }) => programCount === programCountAfterWarmUp),
    `a quality rung compiled a shader after warm-up: ${JSON.stringify({ programCountAfterWarmUp, snapshots })}`,
  );

  const synthetic = await page.evaluate(() => globalThis.__perfGovernorHarness.syntheticLoad());
  assert.equal(synthetic.rung, 2);
  assert.equal(synthetic.actionCount, 2);
  assert.ok(synthetic.p75FrameMs <= 15.5);
  const lock = await page.evaluate(() => globalThis.__perfGovernorHarness.lockScenario());
  assert.deepEqual(lock, { actionCount: 1, rung: 14 });
  assert.deepEqual(errors, []);
  process.stdout.write(
    `${JSON.stringify({ lock, programCountAfterWarmUp, screenshotDirectory, snapshots, synthetic }, null, 2)}\n`,
  );
} finally {
  if (browser !== undefined) await browser.close();
  await server.close();
}
