import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { chromium } from 'playwright';
import { preview } from 'vite';

import { assertPortAvailable } from '../bench/scaffoldBenchUtils.mjs';

const HOST = '127.0.0.1';
const PORT = 4200;
const PAGE_URL = `http://${HOST}:${String(PORT)}/solar-voyager/`;
const SCREENSHOT_DIRECTORY = path.resolve('.playwright-mcp');
const RAW_FIELDS = [
  'startTimeSec',
  'endTimeSec',
  'startProperTimeSec',
  'endProperTimeSec',
  'energySpentJ',
  'properDeltaVMS',
  'peakPowerW',
  'dominantBodyId',
  'progradeDeltaVMS',
  'normalDeltaVMS',
  'radialDeltaVMS',
];

function collectBrowserErrors(page) {
  const errors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('crash', () => errors.push('page crash'));
  return errors;
}

async function dismissWarning(page) {
  const warning = page.locator('#hardware-acceleration-warning');
  if (await warning.isVisible()) {
    await warning.getByRole('button', { name: 'I understand', exact: true }).click();
  }
}

async function startSpace(page, action = 'New Game') {
  await page.getByRole('button', { name: action, exact: true }).click();
  await page.waitForFunction(
    () => {
      const canvas = globalThis.document.querySelector('#space-canvas');
      return (
        canvas instanceof globalThis.HTMLCanvasElement &&
        canvas.dataset.cameraReady === 'true' &&
        canvas.solarVoyagerBurnLog !== undefined
      );
    },
    undefined,
    { timeout: 60_000 },
  );
  await dismissWarning(page);
}

async function readDiagnostic(page) {
  return page.evaluate(() => {
    const canvas = globalThis.document.querySelector('#space-canvas');
    if (!(canvas instanceof globalThis.HTMLCanvasElement)) throw new Error('canvas missing');
    const diagnostic = canvas.solarVoyagerBurnLog;
    if (diagnostic === undefined) throw new Error('burn-log diagnostic missing');
    return structuredClone(diagnostic);
  });
}

function assertRawEntry(actual, expected, label) {
  for (const field of RAW_FIELDS) {
    assert.equal(actual[field], expected[field], `${label}.${field}`);
  }
}

function formatThreeSignificant(value) {
  if (value === 0) return '0';
  const rounded = Number(value.toPrecision(3));
  const magnitude = Math.floor(Math.log10(Math.abs(rounded)));
  return rounded.toFixed(Math.max(0, 2 - magnitude));
}

function formatSi(value, unit) {
  const prefixes = ['', 'k', 'M', 'G', 'T', 'P', 'E', 'Z', 'Y'];
  if (value === 0) return `0 ${unit}`;
  let prefixIndex = Math.min(prefixes.length - 1, Math.max(0, Math.floor(Math.log10(value) / 3)));
  let scaled = value / 1000 ** prefixIndex;
  if (scaled >= 999.5 && prefixIndex < prefixes.length - 1) {
    prefixIndex += 1;
    scaled /= 1_000;
  }
  const rounded = Number(scaled.toPrecision(3));
  const integerDigits = Math.floor(Math.log10(rounded)) + 1;
  return `${rounded.toFixed(Math.max(0, 3 - integerDigits))} ${prefixes[prefixIndex]}${unit}`;
}

function formatDuration(valueSec) {
  const totalMilliseconds = Math.round(valueSec * 1_000);
  const milliseconds = totalMilliseconds % 1_000;
  const totalSeconds = Math.floor(totalMilliseconds / 1_000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const totalHours = Math.floor(totalMinutes / 60);
  const hours = totalHours % 24;
  const days = Math.floor(totalHours / 24);
  const pad = (value, width) => String(value).padStart(width, '0');
  const clock = `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)}.${pad(milliseconds, 3)}`;
  return days === 0 ? clock : `${days}d ${clock}`;
}

function formatUtc(timeSec) {
  return new Date(Date.UTC(2026, 0, 1) + timeSec * 1_000)
    .toISOString()
    .replace('T', ' ')
    .replace('Z', ' UTC');
}

function formatDeltaV(value, signed) {
  if (!signed) {
    const formatter = new Intl.NumberFormat('en-US', {
      maximumSignificantDigits: 3,
      useGrouping: true,
    });
    return value >= 1_000 ? `${formatter.format(value / 1_000)} km/s` : `${formatter.format(value)} m/s`;
  }
  if (value === 0) return '0 m/s';
  const scaled = Math.abs(value) >= 1_000 ? value / 1_000 : value;
  return `${scaled > 0 ? '+' : ''}${formatThreeSignificant(scaled)} ${Math.abs(value) >= 1_000 ? 'km/s' : 'm/s'}`;
}

function expectedMetrics(entry) {
  return [
    formatUtc(entry.startTimeSec),
    formatUtc(entry.endTimeSec),
    formatDuration(entry.startProperTimeSec),
    formatDuration(entry.endProperTimeSec),
    formatSi(entry.energySpentJ / 3_600, 'Wh'),
    formatDeltaV(entry.properDeltaVMS, false),
    formatSi(entry.peakPowerW, 'W'),
    entry.dominantBodyId === null
      ? '—'
      : entry.dominantBodyId.charAt(0).toUpperCase() + entry.dominantBodyId.slice(1),
    formatDeltaV(entry.progradeDeltaVMS, true),
    formatDeltaV(entry.normalDeltaVMS, true),
    formatDeltaV(entry.radialDeltaVMS, true),
  ];
}

async function readMetricValues(locator) {
  return locator.locator('.burn-log-metrics dd').allTextContents();
}

await assertPortAvailable(PORT, HOST);
await mkdir(SCREENSHOT_DIRECTORY, { recursive: true });
const server = await preview({
  root: process.cwd(),
  base: '/solar-voyager/',
  logLevel: 'error',
  preview: { host: HOST, port: PORT, strictPort: true },
});
let browser;
try {
  browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--enable-webgl', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--use-angle=swiftshader'],
  });
  const context = await browser.newContext({ viewport: { width: 1_280, height: 720 } });
  const page = await context.newPage();
  const errors = collectBrowserErrors(page);
  await page.addInitScript(() => {
    Object.defineProperty(globalThis, '__solarVoyagerTestDisableTrajectoryPrediction', {
      configurable: true,
      value: true,
    });
  });
  const response = await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });
  assert.ok(response?.ok(), `burn-log page returned ${String(response?.status())}`);
  await startSpace(page);
  await page.evaluate(() => {
    const canvas = globalThis.document.querySelector('#space-canvas');
    globalThis.__burnLogDiagnosticIdentity = canvas?.solarVoyagerBurnLog;
  });

  const initial = await readDiagnostic(page);
  assert.equal(initial.completedCount, 0);
  assert.equal(initial.activeAvailable, false);
  await page.keyboard.press('KeyR');
  await page.waitForFunction(
    (maximumPublishCount) => {
      const diagnostic = globalThis.document.querySelector('#space-canvas')?.solarVoyagerBurnLog;
      return diagnostic?.activeAvailable === true && diagnostic.publishCount <= maximumPublishCount;
    },
    initial.publishCount + 1,
    { timeout: 2_000 },
  );
  const active = await readDiagnostic(page);
  assert.equal(active.activeAvailable, true);
  assert.ok(active.active.endTimeSec >= active.active.startTimeSec);
  await page.locator('#burn-log-toggle').click();
  assert.deepEqual(await readMetricValues(page.locator('#burn-log-active')), expectedMetrics(active.active));

  await page.keyboard.press('KeyF');
  await page.waitForFunction(
    () => globalThis.document.querySelector('#space-canvas')?.solarVoyagerBurnLog?.completedCount === 1,
    undefined,
    { timeout: 2_000 },
  );
  const completed = await readDiagnostic(page);
  assert.equal(completed.activeAvailable, false);
  assert.equal(completed.latestAvailable, true);
  assert.equal(completed.latest.startTimeSec, active.active.startTimeSec);
  assert.equal(completed.latest.startProperTimeSec, active.active.startProperTimeSec);
  assert.equal(completed.latest.dominantBodyId, active.active.dominantBodyId);
  assert.deepEqual(
    await readMetricValues(page.locator('[data-burn-slot="0"]')),
    expectedMetrics(completed.latest),
  );
  assert.match(await page.locator('#coordinate-clock').textContent(), / UTC$/u);
  assert.match(await page.locator('#proper-time-clock').textContent(), /^\d{2}:\d{2}:\d{2}\.\d{3}$/u);

  const rebuildBeforeFrames = completed.structuralRebuildCount;
  const publishBeforeFrames = completed.publishCount;
  await page.waitForFunction(
    (publishCount) =>
      (globalThis.document.querySelector('#space-canvas')?.solarVoyagerBurnLog?.publishCount ?? 0) >=
      publishCount + 3,
    publishBeforeFrames,
  );
  const unchanged = await readDiagnostic(page);
  assert.equal(unchanged.structuralRebuildCount, rebuildBeforeFrames);
  assert.equal(
    await page.evaluate(
      () =>
        globalThis.__burnLogDiagnosticIdentity ===
        globalThis.document.querySelector('#space-canvas')?.solarVoyagerBurnLog,
    ),
    true,
  );

  const firstRow = page.locator('[data-burn-row="0"]');
  await firstRow.focus();
  await page.keyboard.press('End');
  assert.equal(await firstRow.evaluate((element) => element === globalThis.document.activeElement), true);
  await page.keyboard.press('Escape');
  assert.equal(
    await page.locator('#burn-log-toggle').evaluate((element) => element === globalThis.document.activeElement),
    true,
  );

  await page.locator('#session-settings').evaluate((details) => {
    details.open = true;
  });
  await page.locator('#session-save').click();
  const saved = completed.latest;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await dismissWarning(page);
  await startSpace(page, 'Continue');
  const restored = await readDiagnostic(page);
  assert.equal(restored.completedCount, 1);
  assertRawEntry(restored.latest, saved, 'restored latest');
  assert.equal(restored.structuralRebuildCount, 2, 'replacement must rebuild synchronously once');
  await page.locator('#burn-log-toggle').click();
  assert.deepEqual(
    await readMetricValues(page.locator('[data-burn-slot="0"]')),
    expectedMetrics(restored.latest),
  );
  await page.screenshot({
    path: path.join(SCREENSHOT_DIRECTORY, 'T0098-burn-log-desktop.png'),
    fullPage: true,
  });
  const savedDocument = await page.evaluate(() => localStorage.getItem('solar-voyager.save.v2'));
  assert.deepEqual(errors, []);
  await context.close();

  const compactContext = await browser.newContext({ viewport: { width: 390, height: 720 } });
  const compactPage = await compactContext.newPage();
  const compactErrors = collectBrowserErrors(compactPage);
  // Reuse the real save via a deterministic context transfer.
  assert.notEqual(savedDocument, null);
  await compactPage.addInitScript((document) => localStorage.setItem('solar-voyager.save.v2', document), savedDocument);
  await compactPage.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });
  await dismissWarning(compactPage);
  await startSpace(compactPage, 'Continue');
  await compactPage.locator('#burn-log-toggle').click();
  const bounds = await compactPage.locator('#burn-log-panel').evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      bottom: rect.bottom,
      left: rect.left,
      overflowY: style.overflowY,
      right: rect.right,
      viewportHeight: innerHeight,
      viewportWidth: innerWidth,
    };
  });
  assert.ok(bounds.left >= 0 && bounds.right <= bounds.viewportWidth);
  assert.ok(bounds.bottom <= bounds.viewportHeight);
  assert.equal(bounds.overflowY, 'auto');
  await compactPage.screenshot({
    path: path.join(SCREENSHOT_DIRECTORY, 'T0098-burn-log-compact.png'),
    fullPage: true,
  });
  assert.deepEqual(compactErrors, []);
  await compactContext.close();

  process.stdout.write(`${JSON.stringify({ active, completed, restored, bounds }, null, 2)}\n`);
} finally {
  if (browser !== undefined) await browser.close();
  await server.close();
}
