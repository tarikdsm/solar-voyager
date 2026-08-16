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
 * **`SV_AUDIO_THROTTLE=<rate>` throttles the page CPU** (CDP
 * `Emulation.setCPUThrottlingRate`). Everything this gate measures is bounded in
 * rendered frames, not seconds, and the first version of it was a stopwatch that
 * passed on a developer machine and failed on the CI runner. `SV_AUDIO_THROTTLE=12`
 * reproduces a runner-speed host locally; use it before touching any timing here.
 *
 * The seeded profile is only here to skip the tutorial overlay, which otherwise
 * sits over the settings panel and intercepts the pointer. It carries the shipped
 * mixer defaults verbatim, so the "the shipped default is 0.7" assertions below
 * are still assertions about what players get.
 */

const HOST = '127.0.0.1';
const PORT = 4208;
const PAGE_URL = `http://${HOST}:${String(PORT)}/solar-voyager/?autostart=1`;
const SETTINGS_STORAGE_KEY = 'solar-voyager.settings.v8';
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
      musicLayerGains: Array.from(audio.musicLayerGains),
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

/** Rendered frames a window must cover before "nothing changed" means anything. */
const SETTLE_FRAME_QUORUM = 8;
/**
 * Rendered frames the mix is allowed to keep moving for before we call it stuck.
 *
 * Counted in **frames, not seconds**, because everything the director animates is
 * defined in frames: the 4 s music crossfade advances by the telemetry-clamped
 * frame delta (0.1 s), so it needs 40 rendered frames whatever the frame rate.
 * A wall-clock budget is a bet on the host's speed — this budget is 6x the real
 * cost and holds on a 1 fps software rasteriser exactly as it does at 60 fps.
 */
const SETTLE_FRAME_BUDGET = 240;
/** Wall cap so a dead frame loop fails in minutes with a diagnosis, not never. */
const SETTLE_WALL_CAP_MS = 180_000;

/**
 * Write-resolution epsilons, mirroring `src/game/audio/audioEngine.ts`.
 *
 * Hand-written rather than imported — this is browser-side fixture code, and the
 * `hudPresetProfile.mjs` rule applies: importing the app's own constant would let
 * a change pass this gate by moving both sides at once. Both ways of drifting are
 * safe here. Loosen the engine's epsilon and this gate keeps checking at the old,
 * tighter resolution; tighten it and the engine writes where this gate expects
 * stillness, which fails loudly.
 */
const GAIN_EPSILON = 1e-4;
const FREQUENCY_EPSILON_HZ = 0.5;
const DETUNE_EPSILON_CENTS = 0.05;

/**
 * The director's decision output, quantised to what the engine actually acts on.
 *
 * Exact equality is the wrong comparison and was the second version of this bug:
 * `gammaStress` is derived from the ship's speed, which dithers forever in orbit,
 * so `musicBusGain` and `engineDetuneCents` drift by ~1e-11 per frame and never
 * repeat a value. The engine correctly refuses to write any of it — it is 7 to 9
 * orders of magnitude below the epsilons above — so "unchanged" has to mean
 * "unchanged at the resolution the engine writes at", not "bit-identical".
 * Quantising here is what makes "an unchanged decision costs zero writes" a real
 * guarantee rather than a race against the physics.
 */
function mixFingerprint(sample) {
  const quantise = (value, epsilon) => Math.round(value / epsilon);
  return JSON.stringify({
    engineCutoffHz: quantise(sample.engineCutoffHz, FREQUENCY_EPSILON_HZ),
    engineDetuneCents: quantise(sample.engineDetuneCents, DETUNE_EPSILON_CENTS),
    engineGain: quantise(sample.engineGain, GAIN_EPSILON),
    masterGain: quantise(sample.masterGain, GAIN_EPSILON),
    musicBusGain: quantise(sample.musicBusGain, GAIN_EPSILON),
    musicLayerGains: sample.musicLayerGains.map((gain) => quantise(gain, GAIN_EPSILON)),
    sfxBusGain: quantise(sample.sfxBusGain, GAIN_EPSILON),
    uiBusGain: quantise(sample.uiBusGain, GAIN_EPSILON),
  });
}

/** Names the fields that moved between two samples, for a failure message. */
function describeMixDrift(before, after) {
  const moved = [];
  for (const key of [
    'engineCutoffHz',
    'engineDetuneCents',
    'engineGain',
    'masterGain',
    'musicBusGain',
    'musicLayerGains',
    'sfxBusGain',
    'uiBusGain',
    'musicContext',
    'perspective',
    'warningActive',
  ]) {
    const from = JSON.stringify(before[key]);
    const to = JSON.stringify(after[key]);
    if (from !== to) moved.push(`${key}: ${from} -> ${to}`);
  }
  return moved;
}

/**
 * Waits until the director's published decision state stops moving.
 *
 * Settled means **the state is byte-identical across a window covering at least
 * `SETTLE_FRAME_QUORUM` rendered frames** — not "N samples elapsed". The
 * distinction is the whole point: the opening crossfade is a legitimate,
 * frame-counted change, and the first version of this probe counted wall-clock
 * samples instead, so it passed on a fast host and failed on a slow one without
 * anything being wrong. If the state genuinely never stops moving, the frame
 * budget trips and the message names the fields that kept changing.
 */
async function waitForSettledMix(page) {
  const startedMs = Date.now();
  let anchor = await readAudio(page);
  let anchorPrint = mixFingerprint(anchor);
  const origin = anchor;
  for (;;) {
    await page.waitForTimeout(400);
    const current = await readAudio(page);
    const currentPrint = mixFingerprint(current);
    if (currentPrint === anchorPrint) {
      if (current.frameCount - anchor.frameCount >= SETTLE_FRAME_QUORUM) return current;
    } else {
      anchor = current;
      anchorPrint = currentPrint;
    }
    const framesRendered = current.frameCount - origin.frameCount;
    if (framesRendered > SETTLE_FRAME_BUDGET) {
      throw new Error(
        `the audio mix never settled: still moving after ${String(framesRendered)} rendered ` +
          `frames (budget ${String(SETTLE_FRAME_BUDGET)}). Fields still moving: ` +
          `${describeMixDrift(origin, current).join('; ')}. ` +
          `${JSON.stringify({ current, origin })}`,
      );
    }
    if (Date.now() - startedMs > SETTLE_WALL_CAP_MS) {
      throw new Error(
        `the audio mix never settled: only ${String(framesRendered)} frames rendered in ` +
          `${String(Math.round((Date.now() - startedMs) / 1_000))} s, so this is the frame loop ` +
          `or the runner, not the mix. ${JSON.stringify({ current, origin })}`,
      );
    }
  }
}

/**
 * Counts param writes over a window in which the decision state did not change.
 *
 * The assertion this feeds is "an unchanged decision costs zero writes", which is
 * the actual zero-allocation guarantee. A window in which the state *did* move is
 * not evidence either way, so it is retried rather than passed or failed.
 */
async function measureSteadyWrites(page, settled) {
  let anchor = settled;
  let anchorPrint = mixFingerprint(anchor);
  for (;;) {
    await page.waitForTimeout(400);
    const current = await readAudio(page);
    if (mixFingerprint(current) !== anchorPrint) {
      anchor = await waitForSettledMix(page);
      anchorPrint = mixFingerprint(anchor);
      continue;
    }
    const framesObserved = current.frameCount - anchor.frameCount;
    if (framesObserved >= SETTLE_FRAME_QUORUM) {
      return {
        current,
        framesObserved,
        writes: current.paramWriteCount - anchor.paramWriteCount,
      };
    }
  }
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
  // Slow-host reproduction; inert unless the variable is set (see the header).
  if (process.env.SV_AUDIO_THROTTLE !== undefined) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', {
      rate: Number(process.env.SV_AUDIO_THROTTLE),
    });
  }
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
  const {
    current: steadyAfter,
    framesObserved: steadyFrames,
    writes: steadyWrites,
  } = await measureSteadyWrites(page, settled);
  assert.equal(
    steadyWrites,
    0,
    `an unchanged decision cost ${String(steadyWrites)} param writes across ` +
      `${String(steadyFrames)} rendered frames: ${JSON.stringify({ after: steadyAfter, settled })}`,
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
  logPhase('mixer levels reach the live mix and the v7 profile');

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
          framesObserved: steadyFrames,
          framesToSettle: settled.frameCount,
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
