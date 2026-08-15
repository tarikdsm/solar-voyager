import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { chromium } from 'playwright';
import { createServer } from 'vite';

const HOST = '127.0.0.1';
const PORT = 4187;
const PAGE_URL = `http://${HOST}:${PORT}/solar-voyager/tests/render/impactOverlay.html`;
const SCREENSHOT_DIRECTORY = path.resolve('.playwright-mcp');

async function readOverlay(page) {
  return page.evaluate(() => {
    const overlay = globalThis.document.querySelector('#impact-overlay');
    if (!(overlay instanceof globalThis.HTMLElement)) throw new Error('impact overlay missing');
    const text = (selector) =>
      globalThis.document.querySelector(selector)?.textContent?.trim() ?? null;
    const restore = globalThis.document.querySelector('#impact-restore');
    const respawn = globalThis.document.querySelector('#impact-respawn');
    const rect = overlay.getBoundingClientRect();
    return {
      ariaHidden: overlay.getAttribute('aria-hidden'),
      body: text('#impact-body'),
      bounds: {
        bottom: rect.bottom,
        height: rect.height,
        left: rect.left,
        right: rect.right,
        top: rect.top,
        viewportHeight: globalThis.innerHeight,
        viewportWidth: globalThis.innerWidth,
      },
      focusedId: globalThis.document.activeElement?.id ?? null,
      hidden: overlay.hidden,
      missionTime: text('#impact-mission-time'),
      respawnLabel: respawn?.textContent?.trim() ?? null,
      restoreDisabled: restore instanceof globalThis.HTMLButtonElement ? restore.disabled : null,
      restoreLabel: restore?.textContent?.trim() ?? null,
      role: overlay.getAttribute('role'),
      speed: text('#impact-speed'),
      utc: text('#impact-utc'),
      visible: overlay.dataset.visible,
    };
  });
}

const server = await createServer({
  root: process.cwd(),
  base: '/solar-voyager/',
  logLevel: 'error',
  server: { host: HOST, port: PORT, strictPort: true },
});
let browser;

try {
  await mkdir(SCREENSHOT_DIRECTORY, { recursive: true });
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
  await page.waitForFunction(() => globalThis.__impactOverlayHarness !== undefined);

  // Hidden until contact, and hidden means hidden from assistive tech too.
  const idle = await readOverlay(page);
  assert.equal(idle.hidden, true, 'overlay must start hidden');
  assert.equal(idle.ariaHidden, 'true');
  assert.equal(idle.visible, 'false');
  assert.equal(idle.role, 'alertdialog');

  // Contact with no restore point: respawn is the only way out.
  await page.evaluate(() => globalThis.__impactOverlayHarness.impact(2.5, 1, 0));
  // Preact flushes effects after the render, so focus lands a frame after the
  // signal assignment. Waiting for it is the contract; the exact frame is not.
  await page.waitForFunction(
    () => globalThis.document.activeElement?.id === 'impact-title',
    undefined,
    { timeout: 5_000 },
  );
  const withoutCheckpoint = await readOverlay(page);
  assert.equal(withoutCheckpoint.hidden, false);
  assert.equal(withoutCheckpoint.ariaHidden, 'false');
  assert.equal(withoutCheckpoint.body, 'Moon');
  assert.equal(withoutCheckpoint.speed, '2.5 km/s');
  assert.equal(withoutCheckpoint.missionTime, '01:12:00.000');
  assert.match(withoutCheckpoint.utc, / UTC$/u);
  assert.equal(withoutCheckpoint.restoreDisabled, true);
  assert.equal(withoutCheckpoint.restoreLabel, 'No checkpoint available');
  assert.equal(withoutCheckpoint.respawnLabel, 'Respawn in orbit');
  assert.equal(
    withoutCheckpoint.focusedId,
    'impact-title',
    'focus must move into the overlay when it appears',
  );

  // A disabled restore must not reach the action.
  await page.locator('#impact-restore').click({ force: true });
  assert.deepEqual(await page.evaluate(() => globalThis.__impactOverlayHarness.snapshot()), {
    restoreClicks: 0,
    respawnClicks: 0,
  });

  // With checkpoints available both actions fire exactly once per click.
  await page.evaluate(() => globalThis.__impactOverlayHarness.impact(11.25, 2, 4));
  const withCheckpoint = await readOverlay(page);
  assert.equal(withCheckpoint.body, 'Jupiter');
  assert.equal(withCheckpoint.speed, '11.25 km/s');
  assert.equal(withCheckpoint.restoreDisabled, false);
  assert.equal(withCheckpoint.restoreLabel, 'Restore last checkpoint');
  await page.locator('#impact-restore').click();
  await page.locator('#impact-respawn').click();
  assert.deepEqual(await page.evaluate(() => globalThis.__impactOverlayHarness.snapshot()), {
    restoreClicks: 1,
    respawnClicks: 1,
  });

  // Sub-km/s contact reads in m/s rather than rounding to zero.
  await page.evaluate(() => globalThis.__impactOverlayHarness.impact(0.0421, 0, 2));
  const slow = await readOverlay(page);
  assert.equal(slow.body, 'Earth');
  assert.equal(slow.speed, '42.1 m/s');

  const desktop = await readOverlay(page);
  assert.ok(desktop.bounds.left >= 0 && desktop.bounds.right <= desktop.bounds.viewportWidth);
  assert.ok(desktop.bounds.top >= 0 && desktop.bounds.bottom <= desktop.bounds.viewportHeight);
  // Proves the stylesheet is actually loaded. Without it the section lays out as
  // a full-width block and every bounds assertion below passes for free.
  assert.ok(
    desktop.bounds.right - desktop.bounds.left < desktop.bounds.viewportWidth,
    'overlay is full-bleed on desktop, so app.css did not load',
  );
  await page.screenshot({
    path: path.join(SCREENSHOT_DIRECTORY, 'T0111-impact-overlay-desktop.png'),
    fullPage: true,
  });

  // Compact viewport: the dialog must stay fully on screen.
  await page.setViewportSize({ width: 390, height: 720 });
  const compact = await readOverlay(page);
  assert.ok(
    compact.bounds.left >= 0 && compact.bounds.right <= compact.bounds.viewportWidth,
    'overlay overflows a 390px viewport horizontally',
  );
  assert.ok(
    compact.bounds.top >= 0 && compact.bounds.bottom <= compact.bounds.viewportHeight,
    'overlay overflows a 390px viewport vertically',
  );
  await page.screenshot({
    path: path.join(SCREENSHOT_DIRECTORY, 'T0111-impact-overlay-compact.png'),
    fullPage: true,
  });

  // Recovery hides it again and clears the readouts.
  await page.setViewportSize({ width: 1_280, height: 720 });
  await page.evaluate(() => globalThis.__impactOverlayHarness.clear());
  const cleared = await readOverlay(page);
  assert.equal(cleared.hidden, true);
  assert.equal(cleared.ariaHidden, 'true');
  assert.equal(cleared.body, '—');

  assert.deepEqual(pageErrors, []);
  assert.deepEqual(consoleErrors, []);
  process.stdout.write(
    `${JSON.stringify({ idle, withoutCheckpoint, withCheckpoint, slow, compact, cleared }, null, 2)}\n`,
  );
} finally {
  if (browser !== undefined) await browser.close();
  await server.close();
}
