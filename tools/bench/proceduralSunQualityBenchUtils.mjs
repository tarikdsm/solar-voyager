const QUALITY_ORDER = Object.freeze(['full', 'minimum', 'minimum', 'full']);

export function qualityRunOrder() {
  return [...QUALITY_ORDER];
}

function percentile(sortedValues, fraction) {
  const position = (sortedValues.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const lowerValue = sortedValues[lower];
  const upperValue = sortedValues[upper];
  if (lowerValue === undefined || upperValue === undefined) {
    throw new RangeError('Percentile requires at least one sample.');
  }
  return lowerValue + (upperValue - lowerValue) * (position - lower);
}

function summarize(samples, label) {
  if (samples.length === 0 || samples.some((sample) => !Number.isFinite(sample) || sample <= 0)) {
    throw new RangeError(`${label} GPU samples must be finite and positive.`);
  }
  const sorted = [...samples].sort((left, right) => left - right);
  const roundedPercentile = (fraction) => Number(percentile(sorted, fraction).toFixed(6));
  return {
    sampleCount: sorted.length,
    p50Ms: roundedPercentile(0.5),
    p75Ms: roundedPercentile(0.75),
    p99Ms: roundedPercentile(0.99),
  };
}

export function summarizeQualitySamples(samples) {
  const full = summarize(samples.full, 'Full-quality');
  const minimum = summarize(samples.minimum, 'Minimum-quality');
  return {
    full,
    minimum,
    minimumCheaper: minimum.p75Ms < full.p75Ms,
    p75ReductionPercent: ((full.p75Ms - minimum.p75Ms) / full.p75Ms) * 100,
  };
}
