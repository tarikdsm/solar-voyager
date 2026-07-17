import assert from 'node:assert/strict';

import { chromium } from 'playwright';
import { createServer } from 'vite';

const HOST = '127.0.0.1';
const PORT = 4186;
const PAGE_URL = `http://${HOST}:${PORT}/solar-voyager/tests/render/sessionSettings.html`;

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
  await page.waitForFunction(() => globalThis.__sessionHarness !== undefined);
  await page.getByText('Session & settings', { exact: true }).click();
  await page.locator('#quality-lock').selectOption('low');
  await page.getByRole('button', { name: 'Pitch up: KeyW', exact: true }).click();
  await page.keyboard.press('i');
  assert.equal(await page.locator('#session-status').textContent(), 'Input binding updated');
  await page.getByRole('button', { name: 'Save session', exact: true }).click();
  const saved = await page.evaluate(() => globalThis.__sessionHarness.snapshot());
  await page.evaluate(() => globalThis.__sessionHarness.advance(12));
  await page.locator('#quality-lock').selectOption('high');
  await page.getByRole('button', { name: 'Load session', exact: true }).click();
  const loaded = await page.evaluate(() => globalThis.__sessionHarness.snapshot());

  assert.equal(loaded.simTimeSec, saved.simTimeSec);
  assert.equal(loaded.qualityLock, 'low');
  assert.equal(loaded.pitchUp, 'KeyI');
  assert.equal(loaded.status, 'Session loaded');

  await page.getByText('Session & settings', { exact: true }).click();
  await page.keyboard.down('i');
  const held = await page.evaluate(() => globalThis.__sessionHarness.updateInput());
  await page.keyboard.up('i');
  const released = await page.evaluate(() => globalThis.__sessionHarness.updateInput());
  assert.equal(held.pitchRateRadS, 0.6);
  assert.equal(released.pitchRateRadS, 0);

  await page.getByText('Session & settings', { exact: true }).click();
  await page.getByRole('button', { name: 'Export JSON', exact: true }).click();
  const exported = await page.evaluate(() => globalThis.__sessionHarness.snapshot());
  assert.match(exported.exportedJson, /^\{"version":2,/u);

  const desktop = await page.locator('#session-settings').evaluate((panel) => ({
    clientHeight: panel.clientHeight,
    scrollHeight: panel.scrollHeight,
    right: panel.getBoundingClientRect().right,
  }));
  assert.ok(desktop.right <= 1_280, 'desktop session panel exceeds the viewport');
  assert.ok(desktop.clientHeight <= 720, 'desktop session panel exceeds viewport height');

  await page.setViewportSize({ width: 390, height: 844 });
  const mobile = await page.evaluate(() => ({
    bodyScrollWidth: globalThis.document.body.scrollWidth,
    offenders: [...globalThis.document.querySelectorAll('*')]
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return { className: element.className, id: element.id, left: rect.left, right: rect.right };
      })
      .filter(
        (element) =>
          element.left < 0 || element.right > globalThis.document.documentElement.clientWidth,
      ),
    viewportWidth: globalThis.document.documentElement.clientWidth,
    panelScrollWidth:
      globalThis.document.querySelector('#session-settings')?.scrollWidth ?? 0,
  }));
  assert.ok(
    mobile.bodyScrollWidth <= mobile.viewportWidth,
    `mobile page scrolls horizontally: ${JSON.stringify(mobile)}`,
  );
  assert.ok(mobile.panelScrollWidth <= mobile.viewportWidth, 'mobile panel exceeds viewport width');
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(consoleErrors, []);
  process.stdout.write(`${JSON.stringify({ saved, loaded, held, released, desktop, mobile }, null, 2)}\n`);
} finally {
  if (browser !== undefined) await browser.close();
  await server.close();
}
