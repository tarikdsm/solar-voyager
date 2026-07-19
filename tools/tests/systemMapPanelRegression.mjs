import assert from 'node:assert/strict';

import { chromium } from 'playwright';
import { createServer } from 'vite';

const HOST = '127.0.0.1';
const PORT = 4197;
const PAGE_URL = `http://${HOST}:${String(PORT)}/solar-voyager/tests/render/systemMapPanel.html`;

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
  const toggle = page.locator('#system-map-toggle');
  const panel = page.locator('#system-map-panel');
  await toggle.click();
  await panel.waitFor({ state: 'visible' });

  await page.keyboard.press('Escape');
  await panel.waitFor({ state: 'hidden' });
  assert.equal(await toggle.evaluate((element) => element === globalThis.document.activeElement), true);
  await page.keyboard.press('m');
  await panel.waitFor({ state: 'visible' });

  const editableSelectors = [
    '#map-input-fixture',
    '#map-textarea-fixture',
    '#map-select-fixture',
    '#map-contenteditable-empty',
    '#map-contenteditable-true',
    '#map-contenteditable-descendant',
  ];
  await toggle.click();
  await panel.waitFor({ state: 'hidden' });
  for (const selector of editableSelectors) {
    const editable = page.locator(selector);
    await editable.focus();
    const before = await editable.evaluate((element) =>
      'value' in element ? String(element.value) : (element.textContent ?? ''),
    );
    const mapKeyPrevented = await editable.evaluate((element) => {
      const event = new globalThis.KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        code: 'KeyM',
        key: 'm',
      });
      element.dispatchEvent(event);
      return event.defaultPrevented;
    });
    assert.equal(mapKeyPrevented, false, `${selector} M default was prevented`);
    await panel.waitFor({ state: 'hidden' });
    const afterM = await editable.evaluate((element) =>
      'value' in element ? String(element.value) : (element.textContent ?? ''),
    );
    assert.equal(afterM, before, `${selector} changed after M`);

    await toggle.click();
    await panel.waitFor({ state: 'visible' });
    await editable.focus();
    const escapePrevented = await editable.evaluate((element) => {
      const event = new globalThis.KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        code: 'Escape',
        key: 'Escape',
      });
      element.dispatchEvent(event);
      return event.defaultPrevented;
    });
    assert.equal(escapePrevented, true, `${selector} Escape did not close the map`);
    await panel.waitFor({ state: 'hidden' });
    const afterEscape = await editable.evaluate((element) =>
      'value' in element ? String(element.value) : (element.textContent ?? ''),
    );
    assert.equal(afterEscape, before, `${selector} changed after Escape`);
  }

  assert.deepEqual(pageErrors, []);
  assert.deepEqual(consoleErrors, []);
  process.stdout.write(
    `${JSON.stringify({ editableTargets: editableSelectors.length, focusReturn: true }, null, 2)}\n`,
  );
} finally {
  if (browser !== undefined) await browser.close();
  await server.close();
}
