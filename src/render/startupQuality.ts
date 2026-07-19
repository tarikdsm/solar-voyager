import type { QualityLock } from '../game/settings.js';

export const STARTUP_PROBE_SAMPLE_COUNT = 3;

export interface StartupCapabilities {
  readonly devicePixelRatio: number;
  readonly maxSamples: number;
  readonly maxTextureSize: number;
  readonly softwareRenderer: boolean;
  readonly usedPerformanceCaveatFallback: boolean;
}

/** Selects the documented representative governor rung without side effects. */
export function selectStartupQualityRung(
  lock: QualityLock,
  capabilities: StartupCapabilities,
  probeMeanMs: number,
): 0 | 7 | 14 {
  if (lock !== 'auto') return lock === 'high' ? 0 : lock === 'medium' ? 7 : 14;
  if (!Number.isFinite(capabilities.devicePixelRatio) || capabilities.devicePixelRatio <= 0) {
    throw new RangeError('Startup device pixel ratio must be positive and finite.');
  }
  if (!Number.isInteger(capabilities.maxSamples) || capabilities.maxSamples < 0) {
    throw new RangeError('Startup maximum samples must be a nonnegative integer.');
  }
  if (!Number.isInteger(capabilities.maxTextureSize) || capabilities.maxTextureSize <= 0) {
    throw new RangeError('Startup maximum texture size must be a positive integer.');
  }
  if (!Number.isFinite(probeMeanMs) || probeMeanMs < 0) {
    throw new RangeError('Startup probe duration must be finite and nonnegative.');
  }
  if (capabilities.softwareRenderer || capabilities.usedPerformanceCaveatFallback) return 14;
  if (
    capabilities.devicePixelRatio <= 1.5 &&
    capabilities.maxTextureSize >= 16_384 &&
    capabilities.maxSamples >= 4 &&
    probeMeanMs <= 8
  ) {
    return 0;
  }
  return capabilities.devicePixelRatio <= 2 &&
    capabilities.maxTextureSize >= 8_192 &&
    capabilities.maxSamples >= 2 &&
    probeMeanMs <= 16.6
    ? 7
    : 14;
}

/** Measures exactly three setup-owned samples; never call from the gameplay loop. */
export function measureStartupProbe(sample: () => void, now: () => number): number {
  const startedMs = now();
  if (!Number.isFinite(startedMs)) throw new RangeError('Startup probe clock must be finite.');
  for (let index = 0; index < STARTUP_PROBE_SAMPLE_COUNT; index += 1) sample();
  const durationMs = now() - startedMs;
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    throw new RangeError('Startup probe duration must be finite and nonnegative.');
  }
  return durationMs / STARTUP_PROBE_SAMPLE_COUNT;
}
