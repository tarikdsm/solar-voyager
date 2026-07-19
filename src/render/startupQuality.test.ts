import { describe, expect, it, vi } from 'vitest';

import {
  STARTUP_PROBE_SAMPLE_COUNT,
  measureStartupProbe,
  selectStartupQualityRung,
  type StartupCapabilities,
} from './startupQuality.js';

const HIGH_CAPABILITIES: StartupCapabilities = Object.freeze({
  devicePixelRatio: 1.5,
  maxSamples: 4,
  maxTextureSize: 16_384,
  softwareRenderer: false,
  usedPerformanceCaveatFallback: false,
});

describe('startup quality selection', () => {
  it('selects documented representative rungs at exact high and medium boundaries', () => {
    expect(selectStartupQualityRung('auto', HIGH_CAPABILITIES, 8)).toBe(0);
    expect(
      selectStartupQualityRung(
        'auto',
        {
          ...HIGH_CAPABILITIES,
          devicePixelRatio: 2,
          maxSamples: 2,
          maxTextureSize: 8_192,
        },
        16.6,
      ),
    ).toBe(7);
  });

  it('falls from high to medium for one exceeded high boundary', () => {
    expect(
      selectStartupQualityRung('auto', { ...HIGH_CAPABILITIES, devicePixelRatio: 1.51 }, 8),
    ).toBe(7);
    expect(selectStartupQualityRung('auto', HIGH_CAPABILITIES, 8.01)).toBe(7);
    expect(
      selectStartupQualityRung('auto', { ...HIGH_CAPABILITIES, maxTextureSize: 16_383 }, 8),
    ).toBe(7);
  });

  it('selects low for software, caveat fallback, or an exceeded medium boundary', () => {
    expect(
      selectStartupQualityRung('auto', { ...HIGH_CAPABILITIES, softwareRenderer: true }, 1),
    ).toBe(14);
    expect(
      selectStartupQualityRung(
        'auto',
        { ...HIGH_CAPABILITIES, usedPerformanceCaveatFallback: true },
        1,
      ),
    ).toBe(14);
    expect(
      selectStartupQualityRung('auto', { ...HIGH_CAPABILITIES, devicePixelRatio: 2.01 }, 1),
    ).toBe(14);
    expect(selectStartupQualityRung('auto', HIGH_CAPABILITIES, 16.61)).toBe(14);
  });

  it('makes manual locks authoritative without reading invalid auto evidence', () => {
    const invalid = {
      devicePixelRatio: Number.NaN,
      maxSamples: -1,
      maxTextureSize: -1,
      softwareRenderer: true,
      usedPerformanceCaveatFallback: true,
    };

    expect(selectStartupQualityRung('high', invalid, Number.NaN)).toBe(0);
    expect(selectStartupQualityRung('medium', invalid, Number.NaN)).toBe(7);
    expect(selectStartupQualityRung('low', invalid, Number.NaN)).toBe(14);
  });

  it('rejects malformed automatic capability and timing evidence', () => {
    expect(() =>
      selectStartupQualityRung('auto', { ...HIGH_CAPABILITIES, maxSamples: 1.5 }, 1),
    ).toThrow(/samples/iu);
    expect(() =>
      selectStartupQualityRung('auto', { ...HIGH_CAPABILITIES, devicePixelRatio: 0 }, 1),
    ).toThrow(/pixel ratio/iu);
    expect(() => selectStartupQualityRung('auto', HIGH_CAPABILITIES, Number.NaN)).toThrow(
      /probe/iu,
    );
  });
});

describe('startup timing probe', () => {
  it('runs exactly three fixed samples and returns their finite mean duration', () => {
    const sample = vi.fn();
    const timestamps = [10, 34];
    const now = vi.fn(() => timestamps.shift() ?? Number.NaN);

    expect(measureStartupProbe(sample, now)).toBe(8);
    expect(sample).toHaveBeenCalledTimes(STARTUP_PROBE_SAMPLE_COUNT);
    expect(now).toHaveBeenCalledTimes(2);
  });

  it('rejects a non-monotonic or non-finite probe clock', () => {
    expect(() =>
      measureStartupProbe(
        () => undefined,
        () => Number.NaN,
      ),
    ).toThrow(/clock/iu);
    const timestamps = [10, 9];
    expect(() =>
      measureStartupProbe(
        () => undefined,
        () => timestamps.shift() ?? Number.NaN,
      ),
    ).toThrow(/duration/iu);
  });
});
