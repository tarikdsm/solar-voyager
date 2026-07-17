const SI_PREFIXES = Object.freeze(['', 'k', 'M', 'G', 'T', 'P', 'E', 'Z', 'Y'] as const);

function formatNonNegativeSi(value: number, unit: string, label: string): string {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be finite and non-negative`);
  }
  if (value === 0) return `0 ${unit}`;

  let prefixIndex = Math.min(
    SI_PREFIXES.length - 1,
    Math.max(0, Math.floor(Math.log10(value) / 3)),
  );
  let scaled = value / 1000 ** prefixIndex;
  if (scaled >= 999.5 && prefixIndex < SI_PREFIXES.length - 1) {
    prefixIndex += 1;
    scaled /= 1_000;
  }
  const rounded = Number(scaled.toPrecision(3));
  const integerDigits = Math.floor(Math.log10(rounded)) + 1;
  const decimalPlaces = Math.max(0, 3 - integerDigits);
  return `${rounded.toFixed(decimalPlaces)} ${SI_PREFIXES[prefixIndex]}${unit}`;
}

/** Formats internal joules as watt-hours with three significant digits. */
export function formatEnergyWh(energyJ: number): string {
  return formatNonNegativeSi(energyJ / 3_600, 'Wh', 'energy');
}

/** Formats instantaneous photon-drive power with three significant digits. */
export function formatPowerW(powerW: number): string {
  return formatNonNegativeSi(powerW, 'W', 'power');
}
