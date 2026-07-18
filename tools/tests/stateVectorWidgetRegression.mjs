import assert from 'node:assert/strict';

import { chromium } from 'playwright';
import sharp from 'sharp';
import { createServer } from 'vite';

const HOST = '127.0.0.1';
const PORT = 4188;
const PAGE_URL = `http://${HOST}:${PORT}/solar-voyager/tests/render/stateVectorWidget.html`;

function percentile(sortedValues, percentileValue) {
  return sortedValues[Math.max(0, Math.ceil(sortedValues.length * percentileValue) - 1)] ?? 0;
}

async function inspectViewportPixels(canvas) {
  const screenshot = await canvas.screenshot({ type: 'png' });
  const { data, info } = await sharp(screenshot)
    .extract({ height: 256, left: 128, top: 128, width: 256 })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let darkPixels = 0;
  let chromaticPixels = 0;
  const pixelCount = info.width * info.height;
  for (let offset = 0; offset < data.length; offset += info.channels) {
    const red = data[offset] ?? 0;
    const green = data[offset + 1] ?? 0;
    const blue = data[offset + 2] ?? 0;
    const maximum = Math.max(red, green, blue);
    const minimum = Math.min(red, green, blue);
    const luminance = red * 0.2126 + green * 0.7152 + blue * 0.0722;
    if (luminance < 45) darkPixels += 1;
    if (maximum > 65 && maximum - minimum > 28) chromaticPixels += 1;
  }
  return {
    chromaticPixels,
    darkFraction: darkPixels / pixelCount,
    height: info.height,
    width: info.width,
  };
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
  const page = await browser.newPage({ viewport: { width: 512, height: 512 } });
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => globalThis.__stateVectorWidgetHarness !== undefined);
  const canvas = page.locator('#fixture-canvas');
  const state = await page.evaluate(() => globalThis.__stateVectorWidgetHarness.snapshot());
  assert.equal(state.velocityKmS, 30);
  assert.equal(state.visibleMask, 0b1111);

  const pixels = await inspectViewportPixels(canvas);
  assert.ok(pixels.darkFraction > 0.9, `viewport backdrop is missing: ${JSON.stringify(pixels)}`);
  assert.ok(
    pixels.chromaticPixels >= 24,
    `vector/grid colors are not visible: ${JSON.stringify(pixels)}`,
  );

  const samples = await page.evaluate(() => globalThis.__stateVectorWidgetHarness.measure(40));
  samples.sort((left, right) => left - right);
  const widgetP75Ms = percentile(samples, 0.75);
  if (!state.softwareRasterizer) {
    assert.ok(widgetP75Ms < 1, `hardware widget p75 ${widgetP75Ms.toFixed(3)} ms exceeds 1 ms`);
  }

  assert.deepEqual(pageErrors, []);
  assert.deepEqual(consoleErrors, []);
  process.stdout.write(
    `${JSON.stringify(
      {
        pixels,
        renderer: state.renderer,
        softwareRasterizer: state.softwareRasterizer,
        velocityKmS: state.velocityKmS,
        widgetP75Ms,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  if (browser !== undefined) await browser.close();
  await server.close();
}
