import assert from 'node:assert/strict';

import { chromium } from 'playwright';
import { createServer } from 'vite';

const HOST = '127.0.0.1';
const PORT = 4180;
const PAGE_URL = `http://${HOST}:${PORT}/solar-voyager/tests/render/hudSignals.html`;

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
  const after = await page.evaluate(() => globalThis.__hudSignalsHarness.updateClock());

  assert.deepEqual(before.counts, { app: 1, dualClock: 1, orbitReadout: 1 });
  assert.deepEqual(after.counts, before.counts, 'signal text update rerendered a HUD component');
  assert.equal(before.coordinateClock, '2026-01-01 00:00:00.000 UTC');
  assert.equal(after.coordinateClock, '2026-01-01 00:00:01.000 UTC');
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(consoleErrors, []);
  process.stdout.write(`${JSON.stringify({ before, after }, null, 2)}\n`);
} finally {
  if (browser !== undefined) await browser.close();
  await server.close();
}
