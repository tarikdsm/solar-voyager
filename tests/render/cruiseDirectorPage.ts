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

function runFuzz(): FuzzSummary {
  // One clean Mars run first, to learn how long the route is in fuzz frames.
  const reference = runCruiseScenario({
    targetBodyId: 'mars',
    frameDtSec: FUZZ_FRAME_DT_SEC,
    maxFrames: 40_000,
  });
  const sample = createSampler(0x5_0116);
  const summary: FuzzSummary = {
    runs: 0,
    phasesSeen: [],
    maxDecompressionWallSec: 0,
    failures: [],
  };
  const phases = new Set<string>();
  for (let index = 0; index < FUZZ_RUNS; index += 1) {
    const abortAtFrame = Math.max(1, Math.floor(sample() * reference.frames));
    const result = runCruiseScenario({
      targetBodyId: 'mars',
      frameDtSec: FUZZ_FRAME_DT_SEC,
      maxFrames: 40_000,
      abortAtFrame,
      framesAfterAbort: 120,
    });
    summary.runs += 1;
    phases.add(result.phase);
    summary.maxDecompressionWallSec = Math.max(
      summary.maxDecompressionWallSec,
      result.decompressionWallSec,
    );
    const reasons: string[] = [];
    if (result.phase !== 'aborted') reasons.push(`phase=${result.phase}`);
    if (!result.controllable) reasons.push('not controllable');
    if (result.finalThrottle !== 0) reasons.push(`throttle=${result.finalThrottle}`);
    if (result.finalAttitudeMode !== 'manual') reasons.push(`mode=${result.finalAttitudeMode}`);
    if (result.finalWarp > 100) reasons.push(`warp=${result.finalWarp}`);
    if (result.decompressionWallSec > 1) {
      reasons.push(`decompression=${result.decompressionWallSec}`);
    }
    if (reasons.length > 0) summary.failures.push({ abortAtFrame, reason: reasons.join(', ') });
  }
  summary.phasesSeen = [...phases].sort();
  return summary;
}

const queue: Array<() => void> = [
  () => {
    harness.jupiter = runCruiseScenario({ targetBodyId: 'jupiter', maxFrames: 40_000 });
  },
  () => {
    harness.moon = runCruiseScenario({ targetBodyId: 'moon', maxFrames: 20_000 });
  },
  () => {
    harness.fuzz = runFuzz();
  },
];

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
  // Yield between scenarios so the browser stays responsive and Playwright can
  // observe progress rather than a single multi-minute blocking script.
  setTimeout(pump, 0);
}

document.body.dataset.cruiseStatus = 'running';
setTimeout(pump, 0);
