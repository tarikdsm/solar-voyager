const DEFAULT_STABILITY_LIMIT = 0.05;
const HEAP_CONFIRMATION_FACTOR = 1.25;

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertExactKeys(value, keys, label) {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new RangeError(`${label} has unexpected field "${key}"`);
  }
  for (const key of keys) {
    if (!(key in value)) throw new RangeError(`${label} is missing field "${key}"`);
  }
}

function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive integer`);
  }
  return value;
}

function formatInteger(value) {
  return value.toLocaleString('en-US');
}

function validNonnegativeNumber(value) {
  return Number.isFinite(value) && value >= 0;
}

function symmetricRelativeDifference(left, right) {
  if (left === right) return 0;
  const scale = (Math.abs(left) + Math.abs(right)) / 2;
  return scale === 0 ? Number.POSITIVE_INFINITY : Math.abs(left - right) / scale;
}

function validateCount(label, measured, expected, toleranceFraction, findings) {
  if (!Number.isInteger(measured) || measured < 0) {
    findings.push(`${label} measurement must be a nonnegative integer.`);
    return;
  }
  const minimum = expected * (1 - toleranceFraction);
  const maximum = expected * (1 + toleranceFraction);
  if (measured < minimum || measured > maximum) {
    findings.push(
      `${label} must stay within ${(toleranceFraction * 100).toFixed(1)}% of ${formatInteger(expected)}; measured ${formatInteger(measured)}.`,
    );
  }
}

function compareTimingMetrics(first, second, label, limit, findings) {
  const metrics = ['medianMs', 'p75Ms', 'p99Ms'];
  for (const metric of metrics) {
    const left = first[metric];
    const right = second[metric];
    if (!validNonnegativeNumber(left) || !validNonnegativeNumber(right)) {
      findings.push(`${label} ${metric} values must be finite and nonnegative.`);
      continue;
    }
    const difference = symmetricRelativeDifference(left, right);
    if (difference >= limit) {
      findings.push(
        `${label} ${metric} variance must be < ${(limit * 100).toFixed(1)}%; measured ${(difference * 100).toFixed(2)}%.`,
      );
    }
  }
}

export function validateWorkload(measured, golden) {
  const findings = [];
  if (
    !Number.isInteger(golden.drawCalls) ||
    golden.drawCalls < 0 ||
    !Number.isInteger(golden.triangles) ||
    golden.triangles < 0 ||
    !Number.isFinite(golden.toleranceFraction) ||
    golden.toleranceFraction < 0 ||
    golden.toleranceFraction >= 1
  ) {
    return ['Workload golden is malformed.'];
  }
  validateCount(
    'Draw calls',
    measured.drawCalls,
    golden.drawCalls,
    golden.toleranceFraction,
    findings,
  );
  validateCount(
    'Triangles',
    measured.triangles,
    golden.triangles,
    golden.toleranceFraction,
    findings,
  );
  return findings;
}

export function validateHeapGrowth(measurement, maxRetainedGrowthBytes) {
  if (measurement.beforeBytes === null || measurement.afterBytes === null) {
    return ['Precise Chromium heap metrics are unavailable.'];
  }
  if (
    !validNonnegativeNumber(measurement.beforeBytes) ||
    !validNonnegativeNumber(measurement.afterBytes)
  ) {
    return ['Precise Chromium heap metrics are invalid.'];
  }
  if (!Number.isInteger(maxRetainedGrowthBytes) || maxRetainedGrowthBytes < 0) {
    return ['Retained heap tolerance is malformed.'];
  }
  const growthBytes = measurement.afterBytes - measurement.beforeBytes;
  if (growthBytes > maxRetainedGrowthBytes) {
    return [
      `Retained heap growth must be <= ${formatInteger(maxRetainedGrowthBytes)} bytes; measured ${formatInteger(growthBytes)} bytes.`,
    ];
  }
  return [];
}

export function classifyHeapConfirmation(measurement, maxRetainedGrowthBytes) {
  if (validateHeapGrowth(measurement, maxRetainedGrowthBytes).length === 0) return 'pass';
  if (
    measurement.beforeBytes === null ||
    measurement.afterBytes === null ||
    !validNonnegativeNumber(measurement.beforeBytes) ||
    !validNonnegativeNumber(measurement.afterBytes) ||
    !Number.isInteger(maxRetainedGrowthBytes) ||
    maxRetainedGrowthBytes < 0
  ) {
    return 'fail';
  }
  const growthBytes = measurement.afterBytes - measurement.beforeBytes;
  return growthBytes <= maxRetainedGrowthBytes * HEAP_CONFIRMATION_FACTOR ? 'confirm' : 'fail';
}

export function validateConfirmedHeapGrowth(primary, confirmation, maxRetainedGrowthBytes) {
  const decision = classifyHeapConfirmation(primary, maxRetainedGrowthBytes);
  if (decision === 'pass') return [];
  if (decision === 'fail') return validateHeapGrowth(primary, maxRetainedGrowthBytes);
  if (confirmation === null) {
    return ['Narrow retained heap failure requires a confirmation measurement.'];
  }
  return validateHeapGrowth(confirmation, maxRetainedGrowthBytes).map((finding) =>
    finding.replace('Retained heap growth', 'Confirmed retained heap growth'),
  );
}

/** Sampling period of the pre-measurement heap settling loop, in milliseconds. */
export const HEAP_SETTLE_STEP_MS = 5_000;

/**
 * Growth a single settling step may show and still count as quiet.
 *
 * Scaled from the gate's own ceiling so the two can never drift apart: half of
 * the ceiling's per-step share of the measurement window. With the shipped
 * golden that is 16,384 B per 5 s step against 196,608 B / 30 s.
 */
export function heapSettleStepBudgetBytes(maxRetainedGrowthBytes, durationMs) {
  if (!Number.isInteger(maxRetainedGrowthBytes) || maxRetainedGrowthBytes < 0) {
    throw new RangeError('heap settle budget requires an integer ceiling');
  }
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new RangeError('heap settle budget requires a positive window duration');
  }
  return Math.floor((maxRetainedGrowthBytes * HEAP_SETTLE_STEP_MS) / durationMs / 2);
}

/**
 * Consecutive quiet steps required before the window may be trusted.
 *
 * **At least as much quiet evidence as the window it is about to certify.** The
 * first version of this loop asked for two quiet 5 s steps and then trusted a
 * 30 s window — ten seconds of evidence for a thirty second claim. On CI it duly
 * declared `settled` at 65 s and the very next window grew 277 kB, about 46 kB
 * per step: the page was in a lull, not a steady state. Six steps means a burst
 * with a period shorter than the window cannot hide inside the evidence.
 */
export function heapSettleRequiredSteps(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new RangeError('heap settle step count requires a positive window duration');
  }
  return Math.ceil(durationMs / HEAP_SETTLE_STEP_MS);
}

/**
 * Consecutive-quiet-step tracker, fed one heap sample at a time.
 *
 * Separated from the browser driver so the decision logic can be tested without
 * a page: a synthetic constant-rate leak is instant and deterministic here,
 * whereas the same probe as a browser fixture is confounded by the page's own
 * warm-up (which measures ~111 s on this workload — longer than any cap short
 * enough to be worth paying for on every CI run).
 */
export function createHeapSettleTracker(maxRetainedGrowthBytes, durationMs) {
  const stepBudgetBytes = heapSettleStepBudgetBytes(maxRetainedGrowthBytes, durationMs);
  const requiredSteps = heapSettleRequiredSteps(durationMs);
  let previousBytes = null;
  let stableSteps = 0;
  let steps = 0;
  let peakStepGrowthBytes = 0;
  return {
    /** Feeds one sample; returns whether the run is now settled. */
    observe(bytes) {
      if (previousBytes !== null) {
        const growthBytes = bytes - previousBytes;
        steps += 1;
        if (growthBytes > peakStepGrowthBytes) peakStepGrowthBytes = growthBytes;
        stableSteps = growthBytes <= stepBudgetBytes ? stableSteps + 1 : 0;
      }
      previousBytes = bytes;
      return stableSteps >= requiredSteps;
    },
    get state() {
      return {
        peakStepGrowthBytes,
        requiredSteps,
        settled: stableSteps >= requiredSteps,
        stableSteps,
        stepBudgetBytes,
        steps,
      };
    },
  };
}

/**
 * Turns a settling result into findings.
 *
 * A gate that passes silently when it could not measure is worse than the bug it
 * was fixing: before this, `settled` was logged and never validated, so a page
 * leaking steadily below the per-window ceiling sailed through green while the
 * loop knew perfectly well it had never reached a steady state.
 */
export function validateHeapSettling(settling) {
  if (settling === null || settling === undefined) {
    return ['Retained heap settling was not measured.'];
  }
  if (settling.settled === true) return [];
  return [
    `Retained heap never settled: ${formatInteger(settling.stableSteps ?? 0)} of ` +
      `${formatInteger(settling.requiredSteps ?? 0)} consecutive quiet steps after ` +
      `${formatInteger(settling.elapsedMs ?? 0)} ms, peak step growth ` +
      `${formatInteger(settling.peakStepGrowthBytes ?? 0)} bytes against a ` +
      `${formatInteger(settling.stepBudgetBytes ?? 0)} byte budget. The measurement window ` +
      'cannot be trusted, so it is reported as a failure rather than a pass.',
  ];
}

export function validateBundleSizes(measured, golden) {
  const findings = [];
  if (
    !Number.isInteger(golden.maxEntryGzipBytes) ||
    golden.maxEntryGzipBytes < 0 ||
    !Number.isInteger(golden.maxTotalGzipBytes) ||
    golden.maxTotalGzipBytes < 0
  ) {
    return ['Bundle golden is malformed.'];
  }
  if (!Number.isInteger(measured.entryGzipBytes) || measured.entryGzipBytes < 0) {
    findings.push('Entry bundle gzip measurement must be a nonnegative integer.');
  } else if (measured.entryGzipBytes > golden.maxEntryGzipBytes) {
    findings.push(
      `Entry bundle gzip size must be <= ${formatInteger(golden.maxEntryGzipBytes)} bytes; measured ${formatInteger(measured.entryGzipBytes)} bytes.`,
    );
  }
  if (!Number.isInteger(measured.totalGzipBytes) || measured.totalGzipBytes < 0) {
    findings.push('Total JavaScript/CSS gzip measurement must be a nonnegative integer.');
  } else if (measured.totalGzipBytes > golden.maxTotalGzipBytes) {
    findings.push(
      `Total JavaScript/CSS gzip size must be <= ${formatInteger(golden.maxTotalGzipBytes)} bytes; measured ${formatInteger(measured.totalGzipBytes)} bytes.`,
    );
  }
  return findings;
}

export function compareBenchmarkRuns(first, second, limit = DEFAULT_STABILITY_LIMIT) {
  if (!Number.isFinite(limit) || limit <= 0 || limit >= 1) {
    return ['Benchmark stability limit is malformed.'];
  }
  const findings = [];
  compareTimingMetrics(first, second, 'Benchmark', limit, findings);
  const firstHasHeap = 'steadyHeapAfterBytes' in first;
  const secondHasHeap = 'steadyHeapAfterBytes' in second;
  if (firstHasHeap || secondHasHeap) {
    if (
      !firstHasHeap ||
      !secondHasHeap ||
      !validNonnegativeNumber(first.steadyHeapAfterBytes) ||
      !validNonnegativeNumber(second.steadyHeapAfterBytes)
    ) {
      findings.push('Benchmark steady heap footprints must be finite and present in both runs.');
    } else {
      const heapDifference = symmetricRelativeDifference(
        first.steadyHeapAfterBytes,
        second.steadyHeapAfterBytes,
      );
      if (heapDifference >= limit) {
        findings.push(
          `Benchmark steadyHeapAfterBytes variance must be < ${(limit * 100).toFixed(1)}%; measured ${(heapDifference * 100).toFixed(2)}%.`,
        );
      }
    }
  }
  if (first.maxDrawCalls !== second.maxDrawCalls) {
    findings.push(
      `Benchmark draw-call counts differ: ${formatInteger(first.maxDrawCalls)} versus ${formatInteger(second.maxDrawCalls)}.`,
    );
  }
  if (first.maxTriangles !== second.maxTriangles) {
    findings.push(
      `Benchmark triangle counts differ: ${formatInteger(first.maxTriangles)} versus ${formatInteger(second.maxTriangles)}.`,
    );
  }
  return findings;
}

export function parsePerformanceGolden(value) {
  if (!isRecord(value)) throw new RangeError('performance golden must be an object');
  assertExactKeys(value, ['schemaVersion', 'workload', 'heap', 'bundle'], 'performance golden');
  if (value.schemaVersion !== 1) throw new RangeError('performance golden schemaVersion must be 1');
  if (!isRecord(value.workload)) throw new RangeError('workload must be an object');
  assertExactKeys(
    value.workload,
    ['drawCalls', 'toleranceFraction', 'triangles'],
    'workload',
  );
  if (!Number.isInteger(value.workload.drawCalls) || value.workload.drawCalls < 0) {
    throw new RangeError('workload.drawCalls must be a nonnegative integer');
  }
  if (!Number.isInteger(value.workload.triangles) || value.workload.triangles < 0) {
    throw new RangeError('workload.triangles must be a nonnegative integer');
  }
  if (
    !Number.isFinite(value.workload.toleranceFraction) ||
    value.workload.toleranceFraction <= 0 ||
    value.workload.toleranceFraction >= 1
  ) {
    throw new RangeError('workload.toleranceFraction must be between zero and one');
  }
  if (!isRecord(value.heap)) throw new RangeError('heap must be an object');
  assertExactKeys(
    value.heap,
    ['durationMs', 'fixtureDurationMs', 'maxRetainedGrowthBytes'],
    'heap',
  );
  const durationMs = positiveInteger(value.heap.durationMs, 'heap.durationMs');
  const fixtureDurationMs = positiveInteger(
    value.heap.fixtureDurationMs,
    'heap.fixtureDurationMs',
  );
  if (
    !Number.isInteger(value.heap.maxRetainedGrowthBytes) ||
    value.heap.maxRetainedGrowthBytes < 0
  ) {
    throw new RangeError('heap.maxRetainedGrowthBytes must be a nonnegative integer');
  }
  if (!isRecord(value.bundle)) throw new RangeError('bundle must be an object');
  assertExactKeys(
    value.bundle,
    ['maxEntryGzipBytes', 'maxTotalGzipBytes'],
    'bundle',
  );
  const maxEntryGzipBytes = positiveInteger(
    value.bundle.maxEntryGzipBytes,
    'bundle.maxEntryGzipBytes',
  );
  const maxTotalGzipBytes = positiveInteger(
    value.bundle.maxTotalGzipBytes,
    'bundle.maxTotalGzipBytes',
  );
  return Object.freeze({
    schemaVersion: 1,
    workload: Object.freeze({
      drawCalls: value.workload.drawCalls,
      toleranceFraction: value.workload.toleranceFraction,
      triangles: value.workload.triangles,
    }),
    heap: Object.freeze({
      durationMs,
      fixtureDurationMs,
      maxRetainedGrowthBytes: value.heap.maxRetainedGrowthBytes,
    }),
    bundle: Object.freeze({ maxEntryGzipBytes, maxTotalGzipBytes }),
  });
}
