// T0116 browser gate: the point-and-fly loop, run unattended in a real browser.
//
// Deliberately headless of any renderer — the acceptance is about guidance, and
// the gate must be "headless-time-tolerant" (plan §5 T0116), so it measures the
// *simulated* wall clock (frames x 1/60 s) rather than however long the CI
// runner takes to get through them.

import {
  runCruiseScenario,
  SCENARIO_FRAME_DT_SEC,
  type CruiseScenarioResult,
} from '../../src/game/flight/cruiseScenario.js';

/** Abort samples, per the acceptance criterion. */
const FUZZ_RUNS = 200;

/** Coarser step for the fuzz: same wall-clock coverage, a sixth of the frames. */
const FUZZ_FRAME_DT_SEC = 0.1;

/** Wall seconds the acceptance allows the unattended LEO->Jupiter arrival. */
const ARRIVAL_WALL_BUDGET_SEC = 300;

interface FuzzFailure {
  readonly abortAtFrame: number;
  readonly reason: string;
}

interface FuzzSummary {
  runs: number;
  phasesSeen: string[];
  maxDecompressionWallSec: number;
  failures: FuzzFailure[];
}

interface CruiseDirectorHarness {
  status: 'running' | 'done' | 'failed';
  error: string | null;
  frameDtSec: number;
  arrivalWallBudgetSec: number;
  jupiter: CruiseScenarioResult | null;
  moon: CruiseScenarioResult | null;
  fuzz: FuzzSummary | null;
}

const harness: CruiseDirectorHarness = {
  status: 'running',
  error: null,
  frameDtSec: SCENARIO_FRAME_DT_SEC,
  arrivalWallBudgetSec: ARRIVAL_WALL_BUDGET_SEC,
  jupiter: null,
  moon: null,
  fuzz: null,
};

(
  globalThis as unknown as { __cruiseDirectorHarness: CruiseDirectorHarness }
).__cruiseDirectorHarness = harness;

/**
 * Deterministic sampler (a 32-bit LCG), because "200 random abort times" has to
 * mean the same 200 on every runner or a red gate is not reproducible.
 */
function createSampler(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
}

let fuzzReferenceFrames = 0;
const sample = createSampler(0x5_0116);
const fuzzPhases = new Set<string>();

function runFuzzSample(): void {
  const summary = harness.fuzz as FuzzSummary;
  const abortAtFrame = Math.max(1, Math.floor(sample() * fuzzReferenceFrames));
  const result = runCruiseScenario({
    targetBodyId: 'mars',
    frameDtSec: FUZZ_FRAME_DT_SEC,
    maxFrames: 40_000,
    abortAtFrame,
    framesAfterAbort: 120,
  });
  summary.runs += 1;
  fuzzPhases.add(result.phase);
  summary.phasesSeen = [...fuzzPhases].sort();
  summary.maxDecompressionWallSec = Math.max(
    summary.maxDecompressionWallSec,
    result.decompressionWallSec,
  );
  const reasons: string[] = [];
  if (result.phase !== 'aborted') reasons.push(`phase=${result.phase}`);
  if (!result.releasedControllable) reasons.push('not controllable');
  if (result.releasedThrottle !== 0) reasons.push(`throttle=${result.releasedThrottle}`);
  if (result.releasedAttitudeMode !== 'manual') reasons.push(`mode=${result.releasedAttitudeMode}`);
  if (result.releasedWarp > 100) reasons.push(`warp=${result.releasedWarp}`);
  if (result.decompressionWallSec > 1) reasons.push(`decompression=${result.decompressionWallSec}`);
  if (reasons.length > 0) summary.failures.push({ abortAtFrame, reason: reasons.join(', ') });
}

const queue: Array<() => void> = [
  () => {
    harness.jupiter = runCruiseScenario({ targetBodyId: 'jupiter', maxFrames: 40_000 });
  },
  () => {
    harness.moon = runCruiseScenario({ targetBodyId: 'moon', maxFrames: 20_000 });
  },
  () => {
    // One clean Mars run first, to learn how long the route is in fuzz frames.
    const reference = runCruiseScenario({
      targetBodyId: 'mars',
      frameDtSec: FUZZ_FRAME_DT_SEC,
      maxFrames: 40_000,
    });
    fuzzReferenceFrames = reference.frames;
    harness.fuzz = { runs: 0, phasesSeen: [], maxDecompressionWallSec: 0, failures: [] };
  },
];
for (let index = 0; index < FUZZ_RUNS; index += 1) queue.push(runFuzzSample);

function pump(): void {
  const task = queue.shift();
  if (task === undefined) {
    harness.status = 'done';
    document.body.dataset.cruiseStatus = 'done';
    return;
  }
  try {
    task();
  } catch (error) {
    harness.status = 'failed';
    harness.error = error instanceof Error ? error.message : String(error);
    document.body.dataset.cruiseStatus = 'failed';
    return;
  }
  document.body.dataset.cruiseRemaining = String(queue.length);
  // One scenario per task, yielding in between. The whole gate is minutes of
  // blocking arithmetic; without the yields the page never repaints, and
  // Playwright's rAF-polled waits never get a frame to evaluate in.
  setTimeout(pump, 0);
}

document.body.dataset.cruiseStatus = 'running';
// Late enough that the harness object is observable before the first scenario
// takes the main thread for tens of seconds.
setTimeout(pump, 250);
