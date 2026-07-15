export function percentile(sortedValues, fraction) {
  const position = (sortedValues.length - 1) * fraction;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const lowerValue = sortedValues[lowerIndex];
  const upperValue = sortedValues[upperIndex];

  if (lowerValue === undefined || upperValue === undefined) {
    throw new Error('Cannot calculate a percentile without frame samples.');
  }

  return lowerValue + (upperValue - lowerValue) * (position - lowerIndex);
}
