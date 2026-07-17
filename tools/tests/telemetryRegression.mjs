import assert from 'node:assert/strict';

import { chromium } from 'playwright';
import { createServer } from 'vite';

const HOST = '127.0.0.1';
const PORT = 4183;
const FIXTURE_URL = `http://${HOST}:${PORT}/solar-voyager/tests/render/telemetry.html`;

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
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(FIXTURE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => globalThis.__telemetryBenchmark !== undefined);
  const result = await page.evaluate(() => globalThis.__telemetryBenchmark);

  assert.equal(result.iterations, 100_000);
  assert.equal(result.frameSampleCount, 120);
  assert.equal(result.snapshotStable, true);
  assert.ok(
    result.overheadMsPerFrame < 0.1,
    `telemetry overhead ${result.overheadMsPerFrame.toFixed(6)} ms/frame exceeds 0.1 ms`,
  );
  assert.deepEqual(pageErrors, []);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  if (browser !== undefined) await browser.close();
  await server.close();
}
