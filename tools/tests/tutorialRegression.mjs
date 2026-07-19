import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { chromium } from 'playwright';
import { preview } from 'vite';

import { assertPortAvailable } from '../bench/scaffoldBenchUtils.mjs';
import {
  installTrajectoryPredictionTestHorizon,
  installTrajectoryPredictionTestPointCount,
} from './trajectoryPredictionTestIsolation.mjs';

const HOST = '127.0.0.1';
const PORT = 4201;
const PAGE_URL = `http://${HOST}:${String(PORT)}/solar-voyager/`;
const SETTINGS_STORAGE_KEY = 'solar-voyager.settings.v2';
const SCREENSHOT_DIRECTORY = path.resolve('.playwright-mcp');

function collectBrowserErrors(page) {
  const errors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('crash', () => errors.push('page crash'));
  return errors;
}

async function installBoundedPrediction(page) {
  await installTrajectoryPredictionTestHorizon(page, 3_600);
  await installTrajectoryPredictionTestPointCount(page, 32);
}

async function readTutorialDiagnostic(page) {
  return page.evaluate(() => {
    const canvas = globalThis.document.querySelector('#space-canvas');
    if (!(canvas instanceof globalThis.HTMLCanvasElement)) throw new Error('canvas missing');
    const diagnostic = canvas.solarVoyagerTutorial;
    if (diagnostic === undefined) throw new Error('tutorial diagnostic missing');
    return {
      observerActive: diagnostic.observerActive,
      snapshotObservationCount: diagnostic.snapshotObservationCount,
      status: diagnostic.status,
      stepId: diagnostic.stepId,
      transitionCount: diagnostic.transitionCount,
    };
  });
}

async function readDiagnosticShape(page) {
  return page.evaluate(() => {
    const canvas = globalThis.document.querySelector('#space-canvas');
    if (!(canvas instanceof globalThis.HTMLCanvasElement)) throw new Error('canvas missing');
    const diagnostic = canvas.solarVoyagerTutorial;
    if (diagnostic === undefined) throw new Error('tutorial diagnostic missing');
    const descriptors = Object.values(Object.getOwnPropertyDescriptors(diagnostic));
    return {
      frozen: Object.isFrozen(diagnostic),
      functionCount: Object.values(diagnostic).filter((value) => typeof value === 'function').length,
      nullPrototype: Object.getPrototypeOf(diagnostic) === null,
      readOnly: descriptors.every(
        (descriptor) =>
          descriptor.configurable === false &&
          (descriptor.get === undefined ? descriptor.writable === false : descriptor.set === undefined),
      ),
    };
  });
}

async function waitForSpace(page) {
  await page.waitForFunction(
    () => {
      const canvas = globalThis.document.querySelector('#space-canvas');
      return (
        canvas instanceof globalThis.HTMLCanvasElement &&
        canvas.dataset.cameraReady === 'true' &&
        canvas.solarVoyagerTutorial !== undefined
      );
    },
    undefined,
    { timeout: 60_000 },
  );
}

async function dismissHardwareWarning(page) {
  const warning = page.locator('#hardware-acceleration-warning');
  if (!(await warning.isVisible())) return false;
  const acknowledgment = warning.getByRole('button', { name: 'I understand', exact: true });
  await acknowledgment.focus();
  await page.keyboard.press('Enter');
  await warning.waitFor({ state: 'detached' });
  return true;
}

async function activateWithKeyboard(page, locator) {
  await locator.focus();
  await page.keyboard.press('Enter');
}

async function waitForStep(page, stepId, heading) {
  await page.waitForFunction(
    (expectedStepId) => {
      const canvas = globalThis.document.querySelector('#space-canvas');
      return (
        canvas instanceof globalThis.HTMLCanvasElement &&
        canvas.solarVoyagerTutorial?.status === 'active' &&
        canvas.solarVoyagerTutorial.stepId === expectedStepId
      );
    },
    stepId,
    { timeout: 60_000 },
  );
  const overlay = page.locator('#tutorial-overlay');
  await overlay.waitFor({ state: 'visible' });
  assert.equal(await overlay.count(), 1, `${stepId}: expected one tutorial overlay`);
  const stepHeading = page.locator('#tutorial-step-title');
  await stepHeading.waitFor({ state: 'visible' });
  assert.equal((await stepHeading.textContent())?.trim(), heading);
  await page.waitForFunction(
    () => globalThis.document.activeElement?.id === 'tutorial-step-title',
    undefined,
    { timeout: 5_000 },
  );
}

async function startFreshTutorial(page, dismissWarningBeforeStart = false) {
  const response = await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });
  assert.ok(response?.ok(), `tutorial page returned ${String(response?.status())}`);
  await page.locator('.main-menu').waitFor({ state: 'visible', timeout: 30_000 });
  assert.equal(
    await page.evaluate((key) => globalThis.localStorage.getItem(key), SETTINGS_STORAGE_KEY),
    null,
    'isolated profile did not start with clean settings storage',
  );
  await activateWithKeyboard(page, page.getByRole('button', { name: 'New Game', exact: true }));
  await waitForSpace(page);
  if (dismissWarningBeforeStart) await dismissHardwareWarning(page);
  const offer = page.locator('#tutorial-overlay');
  await offer.waitFor({ state: 'visible' });
  assert.equal(await offer.count(), 1, 'fresh profile rendered an orphaned duplicate offer');
  assert.equal(
    (await page.locator('#tutorial-title').textContent())?.trim(),
    'Optional navigation tutorial',
  );
  await activateWithKeyboard(page, page.getByRole('button', { name: 'Start tutorial' }));
  await waitForStep(page, 'focus-target', 'Focus a target');
}

async function selectMarsWithKeyboard(page) {
  const selector = page.locator('#target-selector');
  await selector.focus();
  await page.keyboard.type('Mars');
  await page.keyboard.press('Enter');
  assert.equal(await selector.inputValue(), 'mars', 'keyboard target selection did not choose Mars');
}

async function runGuidedCompletion(browser) {
  const context = await browser.newContext({ viewport: { width: 1_280, height: 720 } });
  const page = await context.newPage();
  const browserErrors = collectBrowserErrors(page);
  await installBoundedPrediction(page);
  try {
    await startFreshTutorial(page);
    assert.deepEqual(await readDiagnosticShape(page), {
      frozen: true,
      functionCount: 0,
      nullPrototype: true,
      readOnly: true,
    });

    await selectMarsWithKeyboard(page);
    await waitForStep(page, 'camera', 'Orbit/zoom · Shift + Arrows/Page Up/Down');
    await page.keyboard.press('Shift+ArrowLeft');
    assert.equal((await readTutorialDiagnostic(page)).stepId, 'camera');
    await page.keyboard.press('Shift+PageUp');
    await waitForStep(page, 'readouts', 'Read orbit/trajectory data');

    const acknowledgeReadouts = page.getByRole('button', { name: 'I have read them' });
    await acknowledgeReadouts.waitFor({ state: 'visible' });
    await page.waitForFunction(
      () => {
        const button = [...globalThis.document.querySelectorAll('button')].find(
          (candidate) => candidate.textContent?.trim() === 'I have read them',
        );
        return button instanceof globalThis.HTMLButtonElement && !button.disabled;
      },
      undefined,
      { timeout: 60_000 },
    );
    await activateWithKeyboard(page, acknowledgeReadouts);
    await waitForStep(page, 'attitude-thrust', 'Choose attitude, raise throttle');

    await page.keyboard.press('Digit2');
    assert.equal((await readTutorialDiagnostic(page)).stepId, 'attitude-thrust');
    await page.keyboard.press('KeyR');
    await waitForStep(page, 'thrust-off', 'Throttle to zero');
    await page.keyboard.press('KeyF');
    await waitForStep(page, 'warp', 'Change warp from 1×');
    await page.keyboard.press('Equal');
    await waitForStep(page, 'map-open', 'Open the system map');
    await page.keyboard.press('KeyM');
    await page.locator('#system-map-panel').waitFor({ state: 'visible' });
    await waitForStep(page, 'map-return', 'Close the system map');
    await page.keyboard.press('Escape');
    await page.locator('#system-map-panel').waitFor({ state: 'hidden' });
    await waitForStep(page, 'burn-log', 'Open Burn log');

    const burnLogToggle = page.locator('#burn-log-toggle');
    await activateWithKeyboard(page, burnLogToggle);
    await page.locator('[data-burn-row="0"]').waitFor({ state: 'visible' });
    await waitForStep(page, 'performance', 'Performance (F3)');
    await page.screenshot({
      path: path.join(SCREENSHOT_DIRECTORY, 'T0099-guided-burn-log.png'),
      fullPage: true,
    });

    if (await page.locator('#hardware-acceleration-warning').isVisible()) {
      await dismissHardwareWarning(page);
    } else {
      await page.keyboard.press('F3');
      await page.locator('#perf-panel-details').waitFor({ state: 'visible' });
    }
    await waitForStep(page, 'save', 'Save the session');

    const settings = page.locator('#session-settings');
    if ((await settings.getAttribute('open')) === null) {
      await activateWithKeyboard(page, settings.locator('summary'));
    }
    await activateWithKeyboard(page, page.locator('#session-save'));
    await waitForStep(page, 'return-to-play', 'Return to play');
    await page.screenshot({
      path: path.join(SCREENSHOT_DIRECTORY, 'T0099-guided-complete.png'),
      fullPage: true,
    });
    await activateWithKeyboard(page, page.getByRole('button', { name: 'Return to play' }));
    await page.locator('#tutorial-overlay').waitFor({ state: 'detached' });

    const terminal = await readTutorialDiagnostic(page);
    assert.equal(terminal.status, 'completed');
    assert.equal(terminal.stepId, 'return-to-play');
    assert.equal(terminal.observerActive, false);
    assert.ok(terminal.transitionCount >= 13, `unexpected transition count: ${terminal.transitionCount}`);
    assert.ok(terminal.snapshotObservationCount > 0);
    assert.equal(await page.locator('#tutorial-overlay').count(), 0);

    const terminalObservationCount = terminal.snapshotObservationCount;
    const terminalTransitionCount = terminal.transitionCount;
    await page.keyboard.press('KeyR');
    await page.locator('#burn-log-active').waitFor({ state: 'visible' });
    await page.keyboard.press('KeyF');
    await page.locator('#burn-log-active').waitFor({ state: 'hidden' });
    const selectedWarpBefore = await page
      .locator('#warp-control button[aria-pressed="true"]')
      .textContent();
    await page.keyboard.press('Equal');
    await page.waitForFunction(
      (previous) =>
        globalThis.document
          .querySelector('#warp-control button[aria-pressed="true"]')
          ?.textContent?.trim() !== previous,
      selectedWarpBefore?.trim() ?? '',
    );
    const afterTerminalControls = await readTutorialDiagnostic(page);
    assert.equal(
      afterTerminalControls.snapshotObservationCount,
      terminalObservationCount,
      'completed tutorial retained a gameplay snapshot observer',
    );
    assert.equal(afterTerminalControls.transitionCount, terminalTransitionCount);
    assert.equal(await page.locator('#tutorial-overlay').count(), 0);

    const persisted = await page.evaluate((key) => {
      const text = globalThis.localStorage.getItem(key);
      return text === null ? null : JSON.parse(text).tutorial;
    }, SETTINGS_STORAGE_KEY);
    assert.deepEqual(persisted, { status: 'completed', stepId: 'return-to-play' });

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('.main-menu').waitFor({ state: 'visible', timeout: 30_000 });
    await activateWithKeyboard(page, page.getByRole('button', { name: 'Continue', exact: true }));
    await waitForSpace(page);
    await dismissHardwareWarning(page);
    assert.equal(await page.locator('#tutorial-overlay').count(), 0, 'completed tutorial returned');
    const reloaded = await readTutorialDiagnostic(page);
    assert.equal(reloaded.status, 'completed');
    assert.equal(reloaded.observerActive, false);
    assert.deepEqual(browserErrors, []);
    return { persisted, terminal };
  } finally {
    await context.close();
  }
}

async function runSkipResumeReset(browser) {
  const context = await browser.newContext({ viewport: { width: 1_280, height: 720 } });
  const page = await context.newPage();
  const browserErrors = collectBrowserErrors(page);
  await installBoundedPrediction(page);
  try {
    const response = await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });
    assert.ok(response?.ok(), `skip page returned ${String(response?.status())}`);
    await activateWithKeyboard(page, page.getByRole('button', { name: 'New Game', exact: true }));
    await waitForSpace(page);
    await dismissHardwareWarning(page);
    await activateWithKeyboard(page, page.getByRole('button', { name: 'Not now', exact: true }));
    await page.locator('#tutorial-overlay').waitFor({ state: 'detached' });
    assert.deepEqual(
      {
        observerActive: (await readTutorialDiagnostic(page)).observerActive,
        status: (await readTutorialDiagnostic(page)).status,
      },
      { observerActive: false, status: 'skipped' },
    );

    const settings = page.locator('#session-settings');
    await activateWithKeyboard(page, settings.locator('summary'));
    await activateWithKeyboard(page, page.getByRole('button', { name: 'Resume tutorial' }));
    await waitForStep(page, 'focus-target', 'Focus a target');
    await activateWithKeyboard(page, page.getByRole('button', { name: 'Skip tutorial' }));
    await page.locator('#tutorial-overlay').waitFor({ state: 'detached' });
    await activateWithKeyboard(page, settings.locator('summary'));
    await activateWithKeyboard(page, page.getByRole('button', { name: 'Reset tutorial' }));
    await waitForStep(page, 'focus-target', 'Focus a target');
    await activateWithKeyboard(page, page.getByRole('button', { name: 'Skip tutorial' }));
    await page.locator('#tutorial-overlay').waitFor({ state: 'detached' });
    const terminal = await readTutorialDiagnostic(page);
    assert.equal(terminal.status, 'skipped');
    assert.equal(terminal.observerActive, false);
    assert.deepEqual(browserErrors, []);
    return terminal;
  } finally {
    await context.close();
  }
}

function rectanglesOverlap(first, second) {
  return !(
    first.right <= second.left ||
    first.left >= second.right ||
    first.bottom <= second.top ||
    first.top >= second.bottom
  );
}

async function runCompactReducedMotion(browser) {
  const context = await browser.newContext({
    reducedMotion: 'reduce',
    viewport: { width: 360, height: 480 },
  });
  const page = await context.newPage();
  const browserErrors = collectBrowserErrors(page);
  await installBoundedPrediction(page);
  try {
    await startFreshTutorial(page, true);
    const overlay = page.locator('#tutorial-overlay');
    await overlay.scrollIntoViewIfNeeded();
    const compact = await page.evaluate(() => {
      const card = globalThis.document.querySelector('#tutorial-overlay');
      const target = globalThis.document.querySelector('#target-selector');
      if (!(card instanceof globalThis.HTMLElement)) throw new Error('tutorial card missing');
      if (!(target instanceof globalThis.HTMLSelectElement)) throw new Error('target missing');
      const cardStyle = globalThis.getComputedStyle(card);
      const descendants = [card, ...card.querySelectorAll('*')];
      return {
        card: card.getBoundingClientRect().toJSON(),
        descendantsHaveNoMotion: descendants.every((element) => {
          const style = globalThis.getComputedStyle(element);
          return style.animationName === 'none' && style.transitionDuration === '0s';
        }),
        display: cardStyle.display,
        reducedMotion: globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches,
        scrollWidth: globalThis.document.documentElement.scrollWidth,
        target: target.getBoundingClientRect().toJSON(),
        viewportHeight: globalThis.innerHeight,
        viewportWidth: globalThis.innerWidth,
      };
    });
    assert.equal(compact.reducedMotion, true);
    assert.equal(compact.descendantsHaveNoMotion, true);
    assert.notEqual(compact.display, 'none');
    assert.ok(compact.card.left >= 0 && compact.card.top >= 0, JSON.stringify(compact));
    assert.ok(compact.card.right <= compact.viewportWidth, JSON.stringify(compact));
    assert.ok(compact.card.bottom <= compact.viewportHeight, JSON.stringify(compact));
    assert.equal(compact.scrollWidth, compact.viewportWidth);
    assert.equal(
      rectanglesOverlap(compact.card, compact.target),
      false,
      `tutorial obstructed the instructed target selector: ${JSON.stringify(compact)}`,
    );
    assert.equal(
      await page.locator('#tutorial-step-title').evaluate(
        (heading) => heading === globalThis.document.activeElement,
      ),
      true,
    );
    await page.screenshot({
      path: path.join(SCREENSHOT_DIRECTORY, 'T0099-compact-reduced-motion.png'),
      fullPage: true,
    });
    assert.deepEqual(browserErrors, []);
    return compact;
  } finally {
    await context.close();
  }
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
    args: [
      '--enable-webgl',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
      '--use-angle=swiftshader',
    ],
  });
  const guided = await runGuidedCompletion(browser);
  const skipResumeReset = await runSkipResumeReset(browser);
  const compactReducedMotion = await runCompactReducedMotion(browser);
  process.stdout.write(
    `${JSON.stringify({ compactReducedMotion, guided, skipResumeReset }, null, 2)}\n`,
  );
} finally {
  if (browser !== undefined) await browser.close();
  await server.close();
}
