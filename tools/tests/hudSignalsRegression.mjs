import assert from 'node:assert/strict';

import { chromium } from 'playwright';
import { createServer } from 'vite';

const HOST = '127.0.0.1';
const PORT = 4180;
const PAGE_URL = `http://${HOST}:${PORT}/solar-voyager/tests/render/hudSignals.html`;
const WARP_VALUES = [1, 5, 10, 50, 100, 1_000, 10_000, 100_000, 1_000_000, 10_000_000];

async function findHudPanelCollisions(page) {
  return page.evaluate(() => {
    const panels = [...globalThis.document.querySelectorAll('.hud-panel')];
    const overlaps = [];
    for (let leftIndex = 0; leftIndex < panels.length; leftIndex += 1) {
      const left = panels[leftIndex];
      if (!(left instanceof globalThis.HTMLElement)) continue;
      const leftRect = left.getBoundingClientRect();
      for (let rightIndex = leftIndex + 1; rightIndex < panels.length; rightIndex += 1) {
        const right = panels[rightIndex];
        if (!(right instanceof globalThis.HTMLElement)) continue;
        const rightRect = right.getBoundingClientRect();
        const overlapWidth = Math.max(
          0,
          Math.min(leftRect.right, rightRect.right) - Math.max(leftRect.left, rightRect.left),
        );
        const overlapHeight = Math.max(
          0,
          Math.min(leftRect.bottom, rightRect.bottom) - Math.max(leftRect.top, rightRect.top),
        );
        if (overlapWidth * overlapHeight > 0) overlaps.push(`${left.id}/${right.id}`);
      }
    }
    return overlaps;
  });
}

async function assertCameraSurfaceReceivesInput(page, width, height) {
  await page.setViewportSize({ width, height });
  const before = await page.evaluate(() => globalThis.__hudSignalsHarness.snapshot());
  await page.mouse.move(4, Math.floor(height / 2));
  await page.mouse.down();
  await page.mouse.up();
  await page.mouse.wheel(0, 25);
  const after = await page.evaluate(() => globalThis.__hudSignalsHarness.snapshot());
  assert.equal(
    after.cameraPointerDowns,
    before.cameraPointerDowns + 1,
    `${width}x${height} HUD blocks camera pointer input outside panels`,
  );
  assert.equal(
    after.cameraWheels,
    before.cameraWheels + 1,
    `${width}x${height} HUD blocks camera wheel input outside panels`,
  );
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
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1_280, height: 720 } });
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => globalThis.__hudSignalsHarness !== undefined);
  const before = await page.evaluate(() => globalThis.__hudSignalsHarness.snapshot());
  const clamped = await page.evaluate(() => globalThis.__hudSignalsHarness.updateClamp());
  const after = await page.evaluate(() => globalThis.__hudSignalsHarness.updateClock());
  await page.getByRole('button', { name: '100×', exact: true }).click();
  await page.locator('#target-selector').selectOption('mars');
  const afterCommands = await page.evaluate(() => globalThis.__hudSignalsHarness.commitCommands());

  assert.deepEqual(before.counts, {
    app: 1,
    dualClock: 1,
    energyPanel: 1,
    orbitReadout: 1,
    targetPanel: 1,
    warpControl: 1,
  });
  assert.equal(before.burnSummaryLabel, 'Active burn');
  assert.equal(before.burnEnergy, '1.00 kWh');
  assert.equal(before.burnProperDeltaV, '12.3 m/s');
  assert.deepEqual(clamped.counts, before.counts, 'same-frame clamp rerendered a HUD component');
  assert.equal(
    clamped.warpClampStatus,
    'Gravity well · integration budget · 100× sustainable',
  );
  assert.deepEqual(after.counts, before.counts, 'signal text update rerendered a HUD component');
  assert.deepEqual(
    afterCommands.counts,
    before.counts,
    'command snapshot rerendered a HUD component',
  );
  assert.equal(before.coordinateClock, '2026-01-01 00:00:00.000 UTC');
  assert.equal(after.coordinateClock, '2026-01-01 00:00:01.000 UTC');
  assert.equal(afterCommands.commandedWarp, 100);
  assert.equal(afterCommands.commandedTarget, 'mars');
  assert.equal(await page.locator('#target-title').textContent(), 'Mars');
  assert.equal(await page.getByRole('button', { name: '100×', exact: true }).getAttribute('aria-pressed'), 'true');
  const targetPanelMetrics = await page.locator('#target-panel').evaluate((panel) => ({
    clientHeight: panel.clientHeight,
    scrollHeight: panel.scrollHeight,
  }));
  assert.ok(
    targetPanelMetrics.scrollHeight <= targetPanelMetrics.clientHeight,
    `target panel clips its content: ${JSON.stringify(targetPanelMetrics)}`,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileMetrics = await page.evaluate(() => {
    const overlay = globalThis.document.querySelector('.app-overlay');
    if (!(overlay instanceof globalThis.HTMLElement)) throw new Error('app overlay is missing');
    return {
      clientHeight: overlay.clientHeight,
      clippedPanelIds: [...globalThis.document.querySelectorAll('.hud-panel')]
        .filter((panel) => panel.scrollHeight > panel.clientHeight)
        .map((panel) => panel.id),
      scrollHeight: overlay.scrollHeight,
      scrollWidth: overlay.scrollWidth,
      clientWidth: overlay.clientWidth,
    };
  });
  assert.deepEqual(mobileMetrics.clippedPanelIds, []);
  assert.ok(mobileMetrics.scrollHeight > mobileMetrics.clientHeight, 'mobile HUD does not scroll');
  assert.ok(mobileMetrics.scrollWidth <= mobileMetrics.clientWidth, 'mobile HUD scrolls horizontally');
  await page.evaluate(() => {
    const overlay = globalThis.document.querySelector('.app-overlay');
    if (!(overlay instanceof globalThis.HTMLElement)) throw new Error('app overlay is missing');
    overlay.scrollTop = 0;
  });
  await page.locator('#orbit-readout').hover();
  await page.mouse.wheel(0, 300);
  await page.waitForFunction(() => {
    const overlay = globalThis.document.querySelector('.app-overlay');
    return overlay instanceof globalThis.HTMLElement && overlay.scrollTop > 0;
  });

  for (const height of [701, 703, 704]) {
    await page.setViewportSize({ width: 1_280, height });
    assert.deepEqual(
      await findHudPanelCollisions(page),
      [],
      `1280x${height} HUD panels overlap`,
    );
  }

  for (const [width, height] of [
    [900, 720],
    [800, 720],
    [390, 844],
  ]) {
    await assertCameraSurfaceReceivesInput(page, width, height);
  }

  for (const width of [721, 800, 850]) {
    await page.setViewportSize({ width, height: 720 });
    const collisions = await findHudPanelCollisions(page);
    assert.deepEqual(collisions, [], `${width}px HUD panels overlap`);

    const warpButtons = page.locator('#warp-control button');
    assert.equal(await warpButtons.count(), WARP_VALUES.length);
    for (const [index, warp] of WARP_VALUES.entries()) {
      await warpButtons.nth(index).click();
      const commandedWarp = await page.evaluate(
        () => globalThis.__hudSignalsHarness.snapshot().commandedWarp,
      );
      assert.equal(commandedWarp, warp, `${width}px warp button ${warp} is not clickable`);
    }
  }
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(consoleErrors, []);
  process.stdout.write(`${JSON.stringify({ before, after, afterCommands }, null, 2)}\n`);
} finally {
  if (browser !== undefined) await browser.close();
  await server.close();
}
