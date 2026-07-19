const SI_PREFIXES = Object.freeze(['', 'k', 'M', 'G', 'T', 'P', 'E', 'Z', 'Y'] as const);

function padInteger(value: number, width: number): string {
  return Math.trunc(value).toString().padStart(width, '0');
}

function formatThreeSignificant(value: number): string {
  if (value === 0) return '0';
  const rounded = Number(value.toPrecision(3));
  const magnitude = Math.floor(Math.log10(Math.abs(rounded)));
  return rounded.toFixed(Math.max(0, 2 - magnitude));
}

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

/** Formats a nonnegative duration as Dd HH:MM:SS.mmm. */
export function formatDurationSec(valueSec: number): string {
  if (valueSec === Number.POSITIVE_INFINITY) return '∞';
  if (!Number.isFinite(valueSec) || valueSec < 0) return '—';
  const totalMilliseconds = Math.round(valueSec * 1_000);
  const milliseconds = totalMilliseconds % 1_000;
  const totalSeconds = Math.floor(totalMilliseconds / 1_000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const totalHours = Math.floor(totalMinutes / 60);
  const hours = totalHours % 24;
  const days = Math.floor(totalHours / 24);
  const clock = `${padInteger(hours, 2)}:${padInteger(minutes, 2)}:${padInteger(seconds, 2)}.${padInteger(milliseconds, 3)}`;
  return days === 0 ? clock : `${days}d ${clock}`;
}

/** Formats an already-derived UTC display timestamp independently of local timezone. */
export function formatUtcTimeMs(utcTimeMs: number): string {
  if (!Number.isFinite(utcTimeMs)) return '—';
  return new Date(utcTimeMs).toISOString().replace('T', ' ').replace('Z', ' UTC');
}

/** Converts a canonical lowercase body id into a compact display label. */
export function formatBodyId(bodyId: string | null): string {
  if (bodyId === null || bodyId.length === 0) return '—';
  return bodyId.replace(
    /(^|[-_])(\p{L})/gu,
    (_match, separator: string, letter: string) =>
      `${separator.length === 0 ? '' : ' '}${letter.toUpperCase()}`,
  );
}

/** Formats accumulated proper delta-v with three significant digits. */
export function formatProperDeltaV(valueMS: number): string {
  if (!Number.isFinite(valueMS) || valueMS < 0) return '—';
  if (valueMS >= 1_000) return `${formatThreeSignificant(valueMS / 1_000)} km/s`;
  return `${formatThreeSignificant(valueMS)} m/s`;
}

/** Formats one signed burn-axis delta-v component with an explicit positive sign. */
export function formatSignedDeltaV(valueMS: number): string {
  if (!Number.isFinite(valueMS)) return '—';
  if (valueMS === 0) return '0 m/s';
  const absoluteValue = Math.abs(valueMS);
  const unit = absoluteValue >= 1_000 ? 'km/s' : 'm/s';
  const scaledValue = absoluteValue >= 1_000 ? valueMS / 1_000 : valueMS;
  const sign = scaledValue > 0 ? '+' : '';
  return `${sign}${formatThreeSignificant(scaledValue)} ${unit}`;
}
