import { describe, expect, it } from 'vitest';

import { assertGoldenTrajectoryMatches } from './goldenComparison.js';
import type { GoldenTrajectory } from './goldenTrajectoryHarness.js';

function fixture(): GoldenTrajectory {
  return {
    schemaVersion: 1,
    scenarioId: 'leo-30d',
    epoch: 'J2026',
    durationSec: 2_592_000,
    sampleIntervalSec: 86_400,
    integration: { profile: 'production-ship-dp54', maxAcceptedStepsPerSegment: 4_000 },
    parameters: { altitudeKm: 400 },
    initialState: [1, 2, 3, 4, 5, 6, 0],
    samples: [
      {
        timeSec: 86_400,
        state: [0, 0, 0, 0, 0, 0, 0],
        acceptedSteps: 10,
        rejectedSteps: 1,
      },
    ],
  };
}

describe('golden trajectory comparison - physics-spec.md section 7.6', () => {
  it('accepts component drift exactly at the specified limits', () => {
    const expected = fixture();
    const actual = structuredClone(expected);
    (actual.samples[0]?.state as number[])[0] += 1e-3;
    (actual.samples[0]?.state as number[])[3] += 1e-9;
    (actual.samples[0]?.state as number[])[6] += 1e-6;

    expect(() => assertGoldenTrajectoryMatches(actual, expected)).not.toThrow();
  });

  it('reports complete component diagnostics when drift exceeds tolerance', () => {
    const expected = fixture();
    const actual = structuredClone(expected);
    (actual.samples[0]?.state as number[])[4] += 2e-9;

    expect(() => assertGoldenTrajectoryMatches(actual, expected)).toThrow(
      /leo-30d.*timeSec=86400.*component=uy.*expected=0.*actual=2e-9.*drift=2e-9.*limit=1e-9/u,
    );
  });

  it('rejects missing samples before comparing components', () => {
    const expected = fixture();
    const actual = structuredClone(expected);
    actual.samples.length = 0;

    expect(() => assertGoldenTrajectoryMatches(actual, expected)).toThrow(
      /leo-30d sample count mismatch: expected=1, actual=0/u,
    );
  });
});
