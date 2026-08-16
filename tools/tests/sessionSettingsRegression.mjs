import assert from 'node:assert/strict';

import { chromium } from 'playwright';
import { createServer } from 'vite';
import { resolveHarnessPort } from '../harnessPort.mjs';

const HOST = '127.0.0.1';
const PORT = resolveHarnessPort(4186);
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

  // Gamepad settings (T0106): global shaping, per-axis invert/sensitivity, and
  // the "(reserved)" cruise labels all render and persist through the real
  // session -> settings repository path, in a real browser.
  await page.getByText('Session & settings', { exact: true }).click();
  assert.equal(await page.locator('#gamepad-deadzone').inputValue(), '0.08');
  assert.equal(await page.locator('#gamepad-curve-exponent').inputValue(), '1.6');
  assert.equal(await page.locator('#gamepad-axis-pitch-invert').isChecked(), false);
  await page.getByRole('button', { name: 'Cruise engage (reserved): KeyG', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Cruise abort (reserved): KeyV', exact: true }).waitFor();

  await page.locator('#gamepad-deadzone').fill('0.2');
  await page.keyboard.press('Tab');
  assert.equal(await page.locator('#session-status').textContent(), 'Gamepad deadzone updated');
  await page.locator('#gamepad-curve-exponent').fill('2');
  await page.keyboard.press('Tab');
  assert.equal(
    await page.locator('#session-status').textContent(),
    'Gamepad response curve updated',
  );
  await page.locator('#gamepad-axis-roll-sensitivity').fill('1.5');
  await page.keyboard.press('Tab');
  assert.equal(
    await page.locator('#session-status').textContent(),
    'Gamepad axis sensitivity updated',
  );
  await page.locator('#gamepad-axis-pitch-invert').check();
  assert.equal(await page.locator('#session-status').textContent(), 'Gamepad axis invert updated');

  assert.equal(await page.locator('#gamepad-deadzone').inputValue(), '0.2');
  assert.equal(await page.locator('#gamepad-axis-roll-sensitivity').inputValue(), '1.5');
  assert.equal(await page.locator('#gamepad-axis-pitch-invert').isChecked(), true);
  const gamepadSnapshot = await page.evaluate(() => globalThis.__sessionHarness.snapshot());
  const storedGamepad = JSON.parse(gamepadSnapshot.storedProfileJson).gamepad;
  assert.deepEqual(storedGamepad, {
    deadzone: 0.2,
    curveExponent: 2,
    axes: {
      pitch: { invert: true, sensitivity: 1 },
      yaw: { invert: false, sensitivity: 1 },
      roll: { invert: false, sensitivity: 1.5 },
      throttle: { invert: false, sensitivity: 1 },
    },
  });
  // An out-of-range value is rejected and leaves the stored document untouched.
  await page.locator('#gamepad-deadzone').fill('5');
  await page.keyboard.press('Tab');
  assert.equal(
    await page.locator('#session-status').textContent(),
    'Unable to update gamepad deadzone',
  );
  const afterRejected = await page.evaluate(() => globalThis.__sessionHarness.snapshot());
  assert.deepEqual(JSON.parse(afterRejected.storedProfileJson).gamepad, storedGamepad);

  await page.getByRole('button', { name: 'Export JSON', exact: true }).click();
  const exported = await page.evaluate(() => globalThis.__sessionHarness.snapshot());
  assert.match(exported.exportedJson, /^\{"version":3,/u);
  // ADR-034: the exported document carries the session vessel.
  assert.match(exported.exportedJson, /"vessel":\{"restMassKg":10000,"alphaMaxMS2":98\.0665,/u);

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
  process.stdout.write(
    `${JSON.stringify({ saved, loaded, held, released, storedGamepad, desktop, mobile }, null, 2)}\n`,
  );
} finally {
  if (browser !== undefined) await browser.close();
  await server.close();
}
