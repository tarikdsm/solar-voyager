import assert from 'node:assert/strict';

import { chromium } from 'playwright';
import { createServer } from 'vite';

import { disableUnrelatedTrajectoryPrediction } from './trajectoryPredictionTestIsolation.mjs';
import { resolveHarnessPort } from '../harnessPort.mjs';

/**
 * T0125 browser regression: the cinematic camera and photo capture.
 *
 * What only a real browser can prove, and nothing else (the same discipline
 * `cameraControlsRegression.mjs` arrived at after seven CI rounds — the numeric
 * behaviour of the controller, the roll frame and the drift rate live in
 * `src/game/cinematicCameraController.test.ts` at a deterministic frame delta):
 *
 *   1. `O` reaches a mode the shipped build actually implements, orbiting the
 *      ship, with the HUD subtree genuinely hidden from sighted and assistive
 *      users.
 *   2. Holding `E` rolls the camera **and does not jump to Earth**. That
 *      collision — one key bound to cinematic roll and to the hardcoded Earth
 *      shortcut, on two different listeners — is invisible to any unit test that
 *      does not own both halves.
 *   3. `,` / `.` move the field of view and stop at the 20-90 degree envelope.
 *   4. Left alone, the camera drifts.
 *   5. `P` produces a real PNG: the canvas re-render, `toBlob` and the download
 *      anchor all run in the shipped composition, with `preserveDrawingBuffer`
 *      still false. The blob is intercepted rather than written to disk.
 */

const HOST = '127.0.0.1';
const PORT = resolveHarnessPort(4212);
const PAGE_URL = `http://${HOST}:${String(PORT)}/solar-voyager/?autostart=1`;
const CINEMATIC_MIN_FOV_DEG = 20;
const CINEMATIC_MAX_FOV_DEG = 90;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const FILENAME_PATTERN = /^solar-voyager-\d{8}T\d{6}Z-[a-z0-9-]+-\d{3}\.png$/u;

const gateStartMs = Date.now();

function logPhase(message) {
  const elapsedSec = ((Date.now() - gateStartMs) / 1_000).toFixed(1);
  process.stdout.write(`[cinematic-gate +${elapsedSec}s] ${message}\n`);
}

function collectBrowserErrors(page) {
  const errors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('crash', () => errors.push('page crash'));
  return errors;
}

async function readState(page) {
  return page.evaluate(() => {
    const canvas = globalThis.document.querySelector('#space-canvas');
    const camera = canvas?.solarVoyagerCamera;
    const photo = canvas?.solarVoyagerPhoto;
    if (camera === undefined) throw new Error('camera diagnostic missing');
    if (photo === undefined) throw new Error('photo diagnostic missing');
    const surfaces = globalThis.document.querySelector('.space-hud-surfaces');
    return {
      mode: camera.mode,
      focusId: camera.focusId,
      fovDeg: camera.fovDeg,
      cinematicFovDeg: camera.cinematicFovDeg,
      cinematicRollRad: camera.cinematicRollRad,
      cinematicDrifting: camera.cinematicDrifting,
      directFocusEnabled: camera.directFocusEnabled,
      transitioning: camera.transitioning,
      shipDistanceKm: camera.shipDistanceKm,
      positionKm: [camera.positionXKm, camera.positionYKm, camera.positionZKm],
      hudHidden: surfaces?.hasAttribute('hidden') ?? null,
      hudAriaHidden: surfaces?.getAttribute('aria-hidden') ?? null,
      navballCount: globalThis.document.querySelectorAll('.navball').length,
      photo: {
        status: photo.status,
        captureCount: photo.captureCount,
        dropCount: photo.dropCount,
        lastError: photo.lastError,
        lastFilename: photo.lastFilename,
        lastSimTimeSec: photo.lastSimTimeSec,
        lastTauSec: photo.lastTauSec,
        lastDominantBodyId: photo.lastDominantBodyId,
        lastGammaMax: photo.lastGammaMax,
        lastPositionKm: [photo.lastPositionXKm, photo.lastPositionYKm, photo.lastPositionZKm],
      },
    };
  });
}

/** Holds a key for a bounded number of rendered frames, not a wall-clock guess. */
async function holdKey(page, key, frames) {
  await page.keyboard.down(key);
  await page.evaluate(
    (count) =>
      new Promise((resolve) => {
        let remaining = count;
        const step = () => {
          remaining -= 1;
          if (remaining <= 0) resolve();
          else globalThis.requestAnimationFrame(step);
        };
        globalThis.requestAnimationFrame(step);
      }),
    frames,
  );
  await page.keyboard.up(key);
}

async function dismissHardwareWarning(page) {
  const warning = page.locator('#hardware-acceleration-warning');
  if (!(await warning.isVisible())) return;
  await warning.getByRole('button', { name: 'I understand' }).click();
  await warning.waitFor({ state: 'detached', timeout: 10_000 });
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
  logPhase('dev server up');
  browser = await chromium.launch({
    headless: true,
    args: ['--enable-webgl', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 1_280, height: 720 } });
  const errors = collectBrowserErrors(page);
  const downloads = [];
  page.on('download', (download) => {
    downloads.push(download);
  });
  await disableUnrelatedTrajectoryPrediction(page);
  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => globalThis.document.querySelector('#space-canvas')?.dataset.cameraReady === 'true',
    undefined,
    { timeout: 60_000 },
  );
  await dismissHardwareWarning(page);
  logPhase('space phase ready');

  const chase = await readState(page);
  assert.equal(chase.mode, 'chase');
  assert.equal(chase.hudHidden, false, 'the HUD was hidden before photo mode was entered');
  assert.ok(chase.navballCount >= 0);

  // 1. The mode exists in the shipped build and orbits the ship.
  await page.keyboard.press('KeyO');
  await page.waitForFunction(
    () => globalThis.document.querySelector('#space-canvas')?.solarVoyagerCamera.mode === 'cinematic',
    undefined,
    { timeout: 15_000 },
  );
  await page.waitForFunction(
    () => globalThis.document.querySelector('#space-canvas')?.solarVoyagerCamera.transitioning === false,
    undefined,
    { timeout: 30_000 },
  );
  const cinematic = await readState(page);
  assert.equal(cinematic.mode, 'cinematic');
  assert.equal(cinematic.focusId, 'ship', 'photo mode is not looking at the ship');
  assert.ok(
    cinematic.shipDistanceKm > 0 && cinematic.shipDistanceKm < 1,
    `photo mode did not settle near the hull: ${String(cinematic.shipDistanceKm)} km`,
  );
  assert.equal(cinematic.hudHidden, true, 'the HUD is still visible in photo mode');
  assert.equal(cinematic.hudAriaHidden, 'true', 'the HUD is still exposed to assistive tech');
  assert.equal(cinematic.directFocusEnabled, false);
  logPhase('cinematic mode reached, orbiting the ship, HUD hidden');

  // 2. The E collision: roll must happen, and the camera must stay on the ship.
  await holdKey(page, 'KeyE', 12);
  const rolled = await readState(page);
  assert.ok(
    Math.abs(rolled.cinematicRollRad) > 1e-3,
    `holding E did not roll the camera: ${String(rolled.cinematicRollRad)} rad`,
  );
  assert.equal(rolled.mode, 'cinematic', 'E threw the camera out of photo mode');
  assert.equal(rolled.focusId, 'ship', 'E jumped the camera to Earth');
  logPhase(`E rolled ${rolled.cinematicRollRad.toFixed(3)} rad without jumping to Earth`);

  // 3. Field of view, and its envelope.
  await holdKey(page, 'Comma', 30);
  const narrowed = await readState(page);
  assert.ok(
    narrowed.cinematicFovDeg < cinematic.cinematicFovDeg,
    `the field of view did not narrow: ${String(narrowed.cinematicFovDeg)}`,
  );
  assert.ok(narrowed.cinematicFovDeg >= CINEMATIC_MIN_FOV_DEG);
  assert.ok(
    Math.abs(narrowed.fovDeg - narrowed.cinematicFovDeg) < 1e-9,
    'the published pose did not take the cinematic field of view',
  );
  await holdKey(page, 'Period', 360);
  const widened = await readState(page);
  assert.ok(
    widened.cinematicFovDeg <= CINEMATIC_MAX_FOV_DEG,
    `the field of view escaped its envelope: ${String(widened.cinematicFovDeg)}`,
  );
  assert.ok(widened.cinematicFovDeg > narrowed.cinematicFovDeg);
  logPhase(
    `field of view ${narrowed.cinematicFovDeg.toFixed(1)} -> ${widened.cinematicFovDeg.toFixed(1)} deg, clamped`,
  );

  // 4. Left alone, it drifts.
  await page.waitForFunction(
    () =>
      globalThis.document.querySelector('#space-canvas')?.solarVoyagerCamera.cinematicDrifting ===
      true,
    undefined,
    { timeout: 30_000 },
  );
  const drifting = await readState(page);
  assert.ok(
    Math.hypot(
      drifting.positionKm[0] - widened.positionKm[0],
      drifting.positionKm[1] - widened.positionKm[1],
      drifting.positionKm[2] - widened.positionKm[2],
    ) > 0,
    'the idle drift never moved the camera',
  );
  logPhase('idle drift running');

  // 5. A real PNG, through the shipped download path.
  await page.keyboard.press('KeyP');
  await page.waitForFunction(
    () =>
      (globalThis.document.querySelector('#space-canvas')?.solarVoyagerPhoto.captureCount ?? 0) >= 1,
    undefined,
    { timeout: 30_000 },
  );
  const captured = await readState(page);
  assert.equal(captured.photo.status, 'saved');
  assert.equal(captured.photo.captureCount, 1);
  assert.equal(captured.photo.lastError, null);
  assert.match(captured.photo.lastFilename, FILENAME_PATTERN);
  assert.ok(Number.isFinite(captured.photo.lastSimTimeSec));
  assert.ok(Number.isFinite(captured.photo.lastTauSec));
  assert.ok(captured.photo.lastGammaMax >= 1);
  assert.ok(
    captured.photo.lastPositionKm.every((component) => Number.isFinite(component)),
    'the capture stamped a non-finite position',
  );
  assert.ok(
    Math.hypot(...captured.photo.lastPositionKm) > 1e6,
    'the stamped position is not heliocentric',
  );

  // The blob itself: intercepted, never written to the runner's disk.
  const download = downloads[0];
  assert.ok(download !== undefined, 'the download sink produced no browser download');
  assert.equal(download.suggestedFilename(), captured.photo.lastFilename);
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const bytes = Buffer.concat(chunks);
  await download.delete();
  assert.ok(bytes.length > 1_000, `the captured PNG is implausibly small: ${String(bytes.length)} B`);
  assert.ok(bytes.subarray(0, 8).equals(PNG_MAGIC), 'the captured file is not a PNG');
  logPhase(`captured ${captured.photo.lastFilename} (${String(bytes.length)} B PNG)`);

  // Leaving the mode restores the HUD, and the ring keeps walking.
  await page.keyboard.press('KeyO');
  await page.waitForFunction(
    () =>
      globalThis.document.querySelector('#space-canvas')?.solarVoyagerCamera.mode === 'observatory',
    undefined,
    { timeout: 15_000 },
  );
  const observatory = await readState(page);
  assert.equal(observatory.hudHidden, false, 'the HUD did not come back');
  assert.equal(observatory.directFocusEnabled, true);
  assert.notEqual(observatory.focusId, 'ship');
  logPhase('HUD restored on leaving photo mode');

  assert.deepEqual(errors, []);
  process.stdout.write(
    `${JSON.stringify(
      {
        chase: { mode: chase.mode, hudHidden: chase.hudHidden },
        cinematic,
        rollRad: rolled.cinematicRollRad,
        fovDeg: [narrowed.cinematicFovDeg, widened.cinematicFovDeg],
        drifting: drifting.cinematicDrifting,
        photo: captured.photo,
        pngBytes: bytes.length,
        observatory: { mode: observatory.mode, hudHidden: observatory.hudHidden },
      },
      null,
      2,
    )}\n`,
  );
} finally {
  if (browser !== undefined) await browser.close();
  await server.close();
}
