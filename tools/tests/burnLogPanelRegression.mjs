import assert from 'node:assert/strict';

import { chromium } from 'playwright';
import { createServer } from 'vite';

const HOST = '127.0.0.1';
const PORT = 4198;
const PAGE_URL = `http://${HOST}:${String(PORT)}/solar-voyager/tests/render/burnLogPanel.html`;

function assertInsideViewport(box, viewport, label) {
  assert.notEqual(box, null, `${label} bounding box is missing`);
  assert.ok(box.x >= 0, `${label} begins left of the viewport`);
  assert.ok(box.y >= 0, `${label} begins above the viewport`);
  assert.ok(box.x + box.width <= viewport.width + 0.5, `${label} exceeds viewport width`);
  assert.ok(box.y + box.height <= viewport.height + 0.5, `${label} exceeds viewport height`);
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
  const toggle = page.locator('#burn-log-toggle');
  const panel = page.locator('#burn-log-panel');
  const list = page.locator('.burn-log-completed-list');
  await toggle.click();
  await panel.waitFor({ state: 'visible' });
  assert.equal(await page.locator('[data-burn-row]').count(), 256);
  assertInsideViewport(await panel.boundingBox(), { width: 1_280, height: 720 }, 'desktop panel');
  const desktopOverflow = await list.evaluate((element) => ({
    clientHeight: element.clientHeight,
    clientWidth: element.clientWidth,
    overflowY: globalThis.getComputedStyle(element).overflowY,
    scrollHeight: element.scrollHeight,
    scrollWidth: element.scrollWidth,
  }));
  assert.equal(desktopOverflow.overflowY, 'auto');
  assert.ok(desktopOverflow.clientHeight > 80, 'desktop list is not usable');
  assert.ok(desktopOverflow.scrollHeight > desktopOverflow.clientHeight, 'desktop list does not scroll');
  assert.ok(desktopOverflow.scrollWidth <= desktopOverflow.clientWidth, 'desktop list overflows horizontally');

  const first = page.locator('[data-burn-row="0"]');
  await first.focus();
  await page.keyboard.press('ArrowDown');
  assert.equal(
    await page.evaluate(() => globalThis.document.activeElement?.getAttribute('data-burn-row')),
    '1',
  );
  await page.keyboard.press('ArrowUp');
  assert.equal(
    await page.evaluate(() => globalThis.document.activeElement?.getAttribute('data-burn-row')),
    '0',
  );
  await page.keyboard.press('End');
  assert.equal(
    await page.evaluate(() => globalThis.document.activeElement?.getAttribute('data-burn-row')),
    '255',
  );
  await page.keyboard.press('ArrowDown');
  assert.equal(
    await page.evaluate(() => globalThis.document.activeElement?.getAttribute('data-burn-row')),
    '255',
  );
  await page.keyboard.press('Home');
  assert.equal(
    await page.evaluate(() => globalThis.document.activeElement?.getAttribute('data-burn-row')),
    '0',
  );
  await page.keyboard.press('Escape');
  await panel.waitFor({ state: 'hidden' });
  assert.equal(
    await toggle.evaluate((element) => element === globalThis.document.activeElement),
    true,
  );

  await page.setViewportSize({ width: 390, height: 700 });
  await toggle.click();
  await panel.waitFor({ state: 'visible' });
  assertInsideViewport(await panel.boundingBox(), { width: 390, height: 700 }, 'compact panel');
  const compactLayout = await page.evaluate(() => ({
    documentWidth: globalThis.document.documentElement.scrollWidth,
    listClientHeight:
      globalThis.document.querySelector('.burn-log-completed-list')?.clientHeight ?? 0,
    listScrollHeight:
      globalThis.document.querySelector('.burn-log-completed-list')?.scrollHeight ?? 0,
    viewportWidth: globalThis.innerWidth,
  }));
  assert.ok(compactLayout.documentWidth <= compactLayout.viewportWidth, 'compact page overflows horizontally');
  assert.ok(compactLayout.listClientHeight > 80, 'compact list is not usable');
  assert.ok(compactLayout.listScrollHeight > compactLayout.listClientHeight, 'compact list does not scroll');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  const motion = await page.evaluate(() => ({
    panel: globalThis.getComputedStyle(
      globalThis.document.querySelector('#burn-log-panel'),
    ).transitionDuration,
    toggle: globalThis.getComputedStyle(
      globalThis.document.querySelector('#burn-log-toggle'),
    ).transitionDuration,
  }));
  assert.ok(motion.panel.split(',').every((duration) => duration.trim() === '0s'));
  assert.ok(motion.toggle.split(',').every((duration) => duration.trim() === '0s'));

  assert.deepEqual(pageErrors, []);
  assert.deepEqual(consoleErrors, []);
  process.stdout.write(
    `${JSON.stringify({ compactScroll: true, focusNavigation: true, rows: 256 }, null, 2)}\n`,
  );
} finally {
  if (browser !== undefined) await browser.close();
  await server.close();
}
