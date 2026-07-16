import type { GoldenTrajectory } from './goldenTrajectoryHarness.js';

const COMPONENT_NAMES = ['rx', 'ry', 'rz', 'ux', 'uy', 'uz', 'tau'] as const;
const COMPONENT_LIMITS = [1e-3, 1e-3, 1e-3, 1e-9, 1e-9, 1e-9, 1e-6] as const;

/** Fails with component-level diagnostics on physics-spec.md §7.6 golden drift. */
export function assertGoldenTrajectoryMatches(
  actual: GoldenTrajectory,
  expected: GoldenTrajectory,
): void {
  if (actual.scenarioId !== expected.scenarioId) {
    throw new Error(
      `golden scenario mismatch: expected=${expected.scenarioId}, actual=${actual.scenarioId}`,
    );
  }
  if (actual.samples.length !== expected.samples.length) {
    throw new Error(
      `${expected.scenarioId} sample count mismatch: expected=${expected.samples.length}, actual=${actual.samples.length}`,
    );
  }

  for (let sampleIndex = 0; sampleIndex < expected.samples.length; sampleIndex += 1) {
    const expectedSample = expected.samples[sampleIndex];
    const actualSample = actual.samples[sampleIndex];
    if (expectedSample === undefined || actualSample === undefined) {
      throw new Error(`${expected.scenarioId} missing sample at index=${sampleIndex}`);
    }
    if (actualSample.timeSec !== expectedSample.timeSec) {
      throw new Error(
        `${expected.scenarioId} sample time mismatch at index=${sampleIndex}: expected=${expectedSample.timeSec}, actual=${actualSample.timeSec}`,
      );
    }
    if (actualSample.state.length !== COMPONENT_NAMES.length) {
      throw new Error(
        `${expected.scenarioId} state width mismatch at timeSec=${expectedSample.timeSec}: expected=${COMPONENT_NAMES.length}, actual=${actualSample.state.length}`,
      );
    }

    for (let componentIndex = 0; componentIndex < COMPONENT_NAMES.length; componentIndex += 1) {
      const expectedValue = expectedSample.state[componentIndex];
      const actualValue = actualSample.state[componentIndex];
      const component = COMPONENT_NAMES[componentIndex];
      const limit = COMPONENT_LIMITS[componentIndex];
      if (
        expectedValue === undefined ||
        actualValue === undefined ||
        component === undefined ||
        limit === undefined
      ) {
        throw new Error(
          `${expected.scenarioId} missing state component at timeSec=${expectedSample.timeSec}, index=${componentIndex}`,
        );
      }
      const drift = Math.abs(actualValue - expectedValue);
      if (!Number.isFinite(drift) || drift > limit) {
        throw new Error(
          `${expected.scenarioId} golden drift at timeSec=${expectedSample.timeSec}, component=${component}, expected=${expectedValue}, actual=${actualValue}, drift=${drift}, limit=${limit}`,
        );
      }
    }
  }
}
