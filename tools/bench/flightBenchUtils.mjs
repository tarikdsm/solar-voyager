import { percentile } from './scaffoldBenchUtils.mjs';

export const FIXED_FLIGHT_SEED = 0x5a17c0de;
const VIRTUAL_DURATION_SEC = 180;
const LEG_IDS = Object.freeze(['leo', 'moon-flyby', 'jupiter-approach']);
const LEG_TARGETS = Object.freeze(['earth', 'moon', 'jupiter']);

function roundMilliseconds(value) {
  return Number(value.toFixed(3));
}

function nextRandomState(state) {
  let next = state | 0;
  next ^= next << 13;
  next ^= next >>> 17;
  next ^= next << 5;
  return next >>> 0;
}

function summarizeFrameTimes(frameDeltasMs) {
  if (frameDeltasMs.length === 0) {
    throw new Error('Flight benchmark did not capture frame samples.');
  }
  const sorted = frameDeltasMs.toSorted((left, right) => left - right);
  return {
    medianMs: roundMilliseconds(percentile(sorted, 0.5)),
    p75Ms: roundMilliseconds(percentile(sorted, 0.75)),
    p99Ms: roundMilliseconds(percentile(sorted, 0.99)),
  };
}

function summarizeFrameWork(frameWorkMs) {
  const summary = summarizeFrameTimes(frameWorkMs);
  return {
    workMedianMs: summary.medianMs,
    workP75Ms: summary.p75Ms,
    workP99Ms: summary.p99Ms,
  };
}

export function createFlightSchedule(seed = FIXED_FLIGHT_SEED, sampleFrames = 900) {
  if (!Number.isInteger(seed)) throw new RangeError('Flight seed must be an integer.');
  if (!Number.isInteger(sampleFrames) || sampleFrames <= 0 || sampleFrames % 3 !== 0) {
    throw new RangeError('Flight sample frames must be a positive multiple of three.');
  }
  const legFrames = sampleFrames / 3;
  const legs = [];
  for (let index = 0; index < 3; index += 1) {
    const id = LEG_IDS[index];
    const target = LEG_TARGETS[index];
    if (id === undefined || target === undefined) throw new Error('Flight leg catalog is sparse.');
    legs.push(
      Object.freeze({
        endFrame: legFrames * (index + 1),
        endSec: 60 * (index + 1),
        id,
        startFrame: legFrames * index,
        startSec: 60 * index,
        target,
      }),
    );
  }
  const focusEvents = Object.freeze([
    Object.freeze({ frame: legFrames, key: ']' }),
    Object.freeze({ frame: legFrames * 2, key: 'j' }),
  ]);
  const zoomEvents = [];
  const zoomIntervalFrames = Math.max(1, Math.round(sampleFrames / 15));
  let state = seed >>> 0;
  for (let frame = zoomIntervalFrames; frame < sampleFrames; frame += zoomIntervalFrames) {
    state = nextRandomState(state);
    let delta = Math.round(((state / 0x1_0000_0000) * 2 - 1) * 80);
    if (delta === 0) delta = 1;
    zoomEvents.push(Object.freeze({ delta, frame }));
  }
  return Object.freeze({
    focusEvents,
    legs: Object.freeze(legs),
    sampleFrames,
    seed: seed >>> 0,
    virtualDurationSec: VIRTUAL_DURATION_SEC,
    zoomEvents: Object.freeze(zoomEvents),
  });
}

export function summarizeFlightRun(raw) {
  const summary = summarizeFrameTimes(raw.frameDeltasMs);
  const legs = raw.legs.map((leg) =>
    Object.freeze({
      id: leg.id,
      ...summarizeFrameTimes(leg.frameDeltasMs),
      ...summarizeFrameWork(leg.frameWorkMs),
    }),
  );
  const heapDeltaBytes =
    raw.steadyHeapBeforeBytes === null || raw.steadyHeapAfterBytes === null
      ? null
      : raw.steadyHeapAfterBytes - raw.steadyHeapBeforeBytes;
  const pathHeapDeltaBytes =
    raw.pathHeapBeforeBytes === null || raw.pathHeapAfterBytes === null
      ? null
      : raw.pathHeapAfterBytes - raw.pathHeapBeforeBytes;
  return Object.freeze({
    heapDeltaBytes,
    legs: Object.freeze(legs),
    maxDrawCalls: raw.maxDrawCalls,
    maxTriangles: raw.maxTriangles,
    pathHeapDeltaBytes,
    steadyHeapAfterBytes: raw.steadyHeapAfterBytes,
    steadyHeapBeforeBytes: raw.steadyHeapBeforeBytes,
    ...summary,
    ...summarizeFrameWork(raw.frameWorkMs),
  });
}
