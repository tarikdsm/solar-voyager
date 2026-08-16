import assert from 'node:assert/strict';

import { chromium } from 'playwright';
import { preview } from 'vite';

import { assertPortAvailable } from '../bench/scaffoldBenchUtils.mjs';
import { waitForCameraMode } from './cameraWaits.mjs';
import { installEngineerHudPreset } from './hudPresetProfile.mjs';
import { disableUnrelatedTrajectoryPrediction } from './trajectoryPredictionTestIsolation.mjs';

/**
 * T0144 — the audio subsystem in a real browser (ADR-041).
 *
 * Four things only a browser can prove, in this order because the order *is* the
 * contract:
 *
 *  1. **No AudioContext exists before a user gesture.** The page is driven with
 *     `?autostart=1`, which reaches gameplay with no human and therefore no
 *     gesture — the same path six other harnesses take. Every audio assertion
 *     before the first click runs against a page that has never been touched.
 *  2. **No autoplay warning, ever.** This gate collects console **warnings** as
 *     well as errors, which no other harness does: Chrome emits
 *     "The AudioContext was not allowed to start" through CDP `Log.entryAdded`
 *     at `warning` level, and every existing harness filters
 *     `message.type() === 'error'`. Without this the acceptance criterion would
 *     not merely be unverified — it would have looked verified.
 *  3. **Kubrick mode.** Exterior cameras zero the sfx bus; interior restores it.
 *  4. **The mixer persists**, through the v6 profile document.
 *
 * Run `npm run build` first: this drives the production bundle through `preview`,
 * like every other gate that exercises the real app.
 *
 * The seeded profile is only here to skip the tutorial overlay, which otherwise
 * sits over the settings panel and intercepts the pointer. It carries the shipped
 * mixer defaults verbatim, so the "the shipped default is 0.7" assertions below
 * are still assertions about what players get.
 */

const HOST = '127.0.0.1';
const PORT = 4208;
const PAGE_URL = `http://${HOST}:${String(PORT)}/solar-voyager/?autostart=1`;
const SETTINGS_STORAGE_KEY = 'solar-voyager.settings.v7';
/** Chrome's autoplay block, and anything else that mentions the policy. */
const AUTOPLAY_PATTERN = /autoplay|AudioContext was not allowed|was not allowed to start/iu;

function collectBrowserOutput(page) {
  const errors = [];
  const warnings = [];
  page.on('console', (message) => {
    const type = message.type();
    if (type === 'error') errors.push(`console: ${message.text()}`);
    // The one harness that keeps warnings: the message this task must never
    // produce is emitted at warning level, not error level.
    else if (type === 'warning') warnings.push(`warning: ${message.text()}`);
  });
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('crash', () => errors.push('page crash'));
  return { errors, warnings };
}

function assertNoAutoplayWarning(warnings, label) {
  const offending = warnings.filter((line) => AUTOPLAY_PATTERN.test(line));
  assert.deepEqual(
    offending,
    [],
    `${label}: the browser blocked an audio start, so a context was created without a gesture`,
  );
}

/** The software-rendering banner CI always raises; clicking it is a gesture. */
async function dismissHardwareWarning(page) {
  const warning = page.locator('#hardware-acceleration-warning');
  if (!(await warning.isVisible())) return;
  await warning.getByRole('button', { name: 'I understand' }).click();
  await warning.waitFor({ state: 'detached', timeout: 10_000 });
}

async function readAudio(page) {
  return page.evaluate(() => {
    const canvas = globalThis.document.querySelector('#space-canvas');
    const audio = canvas?.solarVoyagerAudio;
    if (audio === undefined) throw new Error('audio diagnostic is missing');
    return {
      contextCreationCount: audio.contextCreationCount,
      contextState: audio.contextState,
      frameCount: canvas?.solarVoyagerTelemetry?.snapshot.frameCount ?? -1,
      engineCutoffHz: audio.engineCutoffHz,
      engineDetuneCents: audio.engineDetuneCents,
      engineGain: audio.engineGain,
      gammaStress: audio.gammaStress,
      identity: audio.identity,
      masterGain: audio.masterGain,
      musicBusGain: audio.musicBusGain,
      musicContext: audio.musicContext,
      paramWriteCount: audio.paramWriteCount,
      perspective: audio.perspective,
      sfxBusGain: audio.sfxBusGain,
      suspendedByVisibility: audio.suspendedByVisibility,
      uiBusGain: audio.uiBusGain,
      unlockAttemptCount: audio.unlockAttemptCount,
      unlocked: audio.unlocked,
      warningActive: audio.warningActive,
      warpMuffle: audio.warpMuffle,
    };
  });
}

async function readStoredAudioProfile(page, key) {
  return page.evaluate((storageKey) => {
    const raw = globalThis.localStorage.getItem(storageKey);
    if (raw === null) return null;
    return JSON.parse(raw).audio ?? null;
  }, key);
}

/** Overrides `document.hidden` and fires the event the composition root listens for. */
async function setPageHidden(page, hidden) {
  await page.evaluate((value) => {
    Object.defineProperty(globalThis.document, 'hidden', {
      configurable: true,
      get: () => value,
    });
    globalThis.document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
}

/** Rendered frames a sample must cover before "nothing changed" means anything. */
const SETTLE_FRAME_QUORUM = 8;

/**
 * Waits until the mix stops writing params **across rendered frames**.
 *
 * Wall clock alone is not enough, and that is the lesson `cameraWaits.mjs`
 * already paid for: the opening crossfade advances by the clamped frame delta
 * (0.1 s), so it needs ~40 frames, and on the software rasteriser this gate runs
 * on the loop can go 400 ms without rendering one. A quiet wall-clock window is
 * then indistinguishable from a settled mix. Requiring `SETTLE_FRAME_QUORUM`
 * rendered frames with zero writes makes the answer frame-rate independent.
 */
async function waitForSettledMix(page, attempts = 60) {
  let previous = await readAudio(page);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await page.waitForTimeout(400);
    const current = await readAudio(page);
    const framesRendered = current.frameCount - previous.frameCount;
    if (current.paramWriteCount === previous.paramWriteCount) {
      if (framesRendered >= SETTLE_FRAME_QUORUM) return current;
    } else previous = current;
  }
  throw new Error(`the audio mix never settled: still writing after ${String(attempts)} samples`);
}

/** Counts param writes over a window covering at least `SETTLE_FRAME_QUORUM` frames. */
async function measureSteadyWrites(page, settled, attempts = 30) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await page.waitForTimeout(400);
    const current = await readAudio(page);
    if (current.frameCount - settled.frameCount >= SETTLE_FRAME_QUORUM) {
      return { current, writes: current.paramWriteCount - settled.paramWriteCount };
    }
  }
  throw new Error('the frame loop never rendered enough frames to measure steady flight');
}

function logPhase(phase) {
  process.stdout.write(`[audio] ${phase}\n`);
}

await assertPortAvailable(PORT, HOST);
const server = await preview({
  root: process.cwd(),
  base: '/solar-voyager/',
  logLevel: 'error',
  preview: { host: HOST, port: PORT, strictPort: true },
});
let browser;

try {
  browser = await chromium.launch({
    headless: true,
    // No `--autoplay-policy=…`: overriding it here would defeat the entire gate.
    args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 1_280, height: 720 } });
  const { errors, warnings } = collectBrowserOutput(page);
  await disableUnrelatedTrajectoryPrediction(page);
  await installEngineerHudPreset(page);
  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () =>
      globalThis.document.querySelector(
        '#space-canvas[data-renderer-ready="true"][data-camera-ready="true"]',
      ) !== null && globalThis.document.querySelector('.app-overlay') !== null,
    undefined,
    { timeout: 60_000 },
  );
  logPhase('gameplay reached with no user gesture');

  // ── 1. Before any gesture. Nothing below this line may click anything. ──
  const untouched = await readAudio(page);
  assert.equal(untouched.identity, 'solarVoyagerAudio.v1');
  assert.equal(untouched.unlocked, false, 'the engine unlocked without a gesture');
  assert.equal(untouched.contextState, 'none', 'an AudioContext exists without a gesture');
  assert.equal(untouched.contextCreationCount, 0);
  assert.equal(untouched.unlockAttemptCount, 0);
  assert.equal(untouched.paramWriteCount, 0, 'params were written with no graph to write to');
  // The decisions run anyway — that separation is the point of the director.
  assert.equal(untouched.perspective, 'interior');
  assert.equal(untouched.musicContext, 'deep-space');
  assert.ok(untouched.masterGain > 0, 'the shipped default is muted');
  assert.ok(untouched.engineGain > 0, 'the idle drive bed is silent');
  assertNoAutoplayWarning(warnings, 'before any gesture');
  logPhase('no context, no warning, decisions live');

  // ── 2. First gesture. ──
  await dismissHardwareWarning(page);
  await page.locator('#space-canvas').click({ position: { x: 8, y: 8 } });
  await page.waitForFunction(
    () => globalThis.document.querySelector('#space-canvas')?.solarVoyagerAudio?.unlocked === true,
    undefined,
    { timeout: 10_000 },
  );
  await page.waitForFunction(
    () =>
      globalThis.document.querySelector('#space-canvas')?.solarVoyagerAudio?.contextState ===
      'running',
    undefined,
    { timeout: 20_000 },
  );
  const unlocked = await readAudio(page);
  assert.equal(unlocked.contextCreationCount, 1, 'more than one AudioContext was created');
  assert.ok(unlocked.paramWriteCount > 0, 'the graph was built but never driven');
  assert.equal(unlocked.suspendedByVisibility, false);
  assertNoAutoplayWarning(warnings, 'after the first gesture');
  logPhase(`unlocked: ${unlocked.contextState}, ${String(unlocked.paramWriteCount)} param writes`);

  // Steady flight writes nothing: the engine only touches a param that moved.
  // Measured after the mix settles, because the 4 s opening music crossfade is a
  // genuine change and is still running when the first gesture arrives — the
  // claim is "a frame that changes nothing costs nothing", not "audio never
  // writes".
  const settled = await waitForSettledMix(page);
  const { current: steadyAfter, writes: steadyWrites } = await measureSteadyWrites(page, settled);
  assert.equal(
    steadyWrites,
    0,
    `steady flight rewrote ${String(steadyWrites)} params across ` +
      `${String(steadyAfter.frameCount - settled.frameCount)} frames of unchanged state: ` +
      `${JSON.stringify({ after: steadyAfter, settled })}`,
  );

  // ── 3. Kubrick mode. `]` steps the focus ring off the ship into observatory. ──
  await page.keyboard.press(']');
  await waitForCameraMode(page, 'observatory');
  const exterior = await readAudio(page);
  assert.equal(exterior.perspective, 'exterior');
  assert.equal(exterior.sfxBusGain, 0, 'the sfx bus survived an exterior camera');
  // Music follows its own setting, which defaults to on.
  assert.ok(exterior.musicBusGain > 0, 'the score was silenced with the ship');
  assert.ok(exterior.uiBusGain > 0, 'the ui bus was silenced by the camera');
  await page.keyboard.press('[');
  await waitForCameraMode(page, 'chase');
  const interior = await readAudio(page);
  assert.equal(interior.perspective, 'interior');
  assert.ok(interior.sfxBusGain > 0, 'the sfx bus never came back on the interior camera');
  logPhase('Kubrick mode silences and restores the sfx bus');

  // ── 4. Hidden tab. ──
  await setPageHidden(page, true);
  await page.waitForFunction(
    () =>
      globalThis.document.querySelector('#space-canvas')?.solarVoyagerAudio?.contextState ===
      'suspended',
    undefined,
    { timeout: 10_000 },
  );
  assert.equal((await readAudio(page)).suspendedByVisibility, true);
  await setPageHidden(page, false);
  await page.waitForFunction(
    () =>
      globalThis.document.querySelector('#space-canvas')?.solarVoyagerAudio?.contextState ===
      'running',
    undefined,
    { timeout: 10_000 },
  );
  const resumed = await readAudio(page);
  assert.equal(resumed.suspendedByVisibility, false);
  assert.equal(resumed.contextCreationCount, 1, 'a suspend/resume cycle built a second context');
  logPhase('suspends on a hidden tab and resumes on return');

  // ── 5. Mixer: the control, the live mix and the persisted profile. ──
  await page.getByText('Session & settings', { exact: true }).click();
  const masterSlider = page.locator('#audio-master');
  await masterSlider.waitFor({ state: 'visible', timeout: 10_000 });
  assert.equal(await masterSlider.inputValue(), '0.7', 'the shipped master default moved');
  assert.equal(await page.locator('#audio-exterior-music').isChecked(), true);
  await masterSlider.fill('0');
  await page.waitForFunction(
    () => globalThis.document.querySelector('#space-canvas')?.solarVoyagerAudio?.masterGain === 0,
    undefined,
    { timeout: 10_000 },
  );
  const storedMuted = await readStoredAudioProfile(page, SETTINGS_STORAGE_KEY);
  assert.deepEqual(storedMuted, { master: 0, music: 0.5, sfx: 0.7, ui: 0.5, exteriorMusic: true });
  await page.locator('#audio-exterior-music').uncheck();
  await masterSlider.fill('0.4');
  const storedFinal = await readStoredAudioProfile(page, SETTINGS_STORAGE_KEY);
  assert.deepEqual(storedFinal, {
    master: 0.4,
    music: 0.5,
    sfx: 0.7,
    ui: 0.5,
    exteriorMusic: false,
  });
  // Vacuum on both counts now: the score goes with the ship. Collapse the panel
  // and put focus back on the canvas first — `blocksGameKey` correctly suppresses
  // game keys while a form control has focus.
  await page.getByText('Session & settings', { exact: true }).click();
  await page.locator('#space-canvas').click({ position: { x: 8, y: 8 } });
  await page.keyboard.press(']');
  await waitForCameraMode(page, 'observatory');
  const vacuum = await readAudio(page);
  assert.equal(vacuum.musicBusGain, 0, 'the score survived exteriorMusic being turned off');
  assert.equal(vacuum.sfxBusGain, 0);
  logPhase('mixer levels reach the live mix and the v6 profile');

  assertNoAutoplayWarning(warnings, 'end of run');
  assert.deepEqual(errors, []);

  process.stdout.write(
    `${JSON.stringify(
      {
        beforeGesture: {
          contextCreationCount: untouched.contextCreationCount,
          contextState: untouched.contextState,
          masterGain: untouched.masterGain,
          musicContext: untouched.musicContext,
          paramWriteCount: untouched.paramWriteCount,
          unlocked: untouched.unlocked,
        },
        afterGesture: {
          contextCreationCount: unlocked.contextCreationCount,
          contextState: unlocked.contextState,
          paramWriteCount: unlocked.paramWriteCount,
        },
        kubrick: {
          exteriorMusicBusGain: exterior.musicBusGain,
          exteriorSfxBusGain: exterior.sfxBusGain,
          interiorSfxBusGain: interior.sfxBusGain,
          vacuumMusicBusGain: vacuum.musicBusGain,
        },
        mixer: { storedFinal },
        steadyFlight: {
          framesObserved: steadyAfter.frameCount - settled.frameCount,
          paramWrites: steadyWrites,
        },
        visibility: { resumedState: resumed.contextState },
        // Printed, not just counted: a future run must be able to tell one
        // benign software-rasteriser warning from an autoplay warning that
        // slipped the pattern.
        warnings,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  if (browser !== undefined) await browser.close();
  await server.close();
}
