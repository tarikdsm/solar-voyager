const DEFAULT_STABILITY_LIMIT = 0.05;

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
  for (const metric of ['medianMs', 'p75Ms', 'p99Ms']) {
    const left = first[metric];
    const right = second[metric];
    if (!validNonnegativeNumber(left) || !validNonnegativeNumber(right)) {
      findings.push(`Benchmark ${metric} values must be finite and nonnegative.`);
      continue;
    }
    const difference = symmetricRelativeDifference(left, right);
    if (difference >= limit) {
      findings.push(
        `Benchmark ${metric} variance must be < ${(limit * 100).toFixed(1)}%; measured ${(difference * 100).toFixed(2)}%.`,
      );
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
