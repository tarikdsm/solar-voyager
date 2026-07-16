import type { GoldenTrajectory } from './goldenTrajectoryHarness.js';

const COMPONENT_NAMES = ['rx', 'ry', 'rz', 'ux', 'uy', 'uz', 'tau'] as const;
const STABLE_COMPONENT_LIMITS = [1e-3, 1e-3, 1e-3, 1e-9, 1e-9, 1e-9, 1e-6] as const;
const LEO_COMPONENT_LIMITS = [2e-2, 2e-2, 2e-2, 2e-5, 2e-5, 2e-5, 1e-6] as const;

function componentLimits(scenarioId: string): readonly number[] {
  return scenarioId === 'leo-30d' ? LEO_COMPONENT_LIMITS : STABLE_COMPONENT_LIMITS;
}

function assertScalarMatches(
  scenarioId: string,
  label: string,
  actual: number | string,
  expected: number | string,
): void {
  if (actual !== expected) {
    throw new Error(`${scenarioId} ${label} mismatch: expected=${expected}, actual=${actual}`);
  }
}

function assertParametersMatch(actual: GoldenTrajectory, expected: GoldenTrajectory): void {
  const actualKeys = Object.keys(actual.parameters).sort();
  const expectedKeys = Object.keys(expected.parameters).sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    throw new Error(
      `${expected.scenarioId} parameter keys mismatch: expected=${JSON.stringify(expectedKeys)}, actual=${JSON.stringify(actualKeys)}`,
    );
  }
  for (const key of expectedKeys) {
    if (actual.parameters[key] !== expected.parameters[key]) {
      throw new Error(
        `${expected.scenarioId} parameters mismatch: expected=${JSON.stringify(expected.parameters)}, actual=${JSON.stringify(actual.parameters)}`,
      );
    }
  }
}

function assertStateMatches(
  scenarioId: string,
  label: string,
  actualState: readonly number[],
  expectedState: readonly number[],
  limits: readonly number[],
): void {
  if (actualState.length !== COMPONENT_NAMES.length) {
    throw new Error(
      `${scenarioId} ${label} width mismatch: expected=${COMPONENT_NAMES.length}, actual=${actualState.length}`,
    );
  }
  for (let componentIndex = 0; componentIndex < COMPONENT_NAMES.length; componentIndex += 1) {
    const expectedValue = expectedState[componentIndex];
    const actualValue = actualState[componentIndex];
    const component = COMPONENT_NAMES[componentIndex];
    const limit = limits[componentIndex];
    if (
      expectedValue === undefined ||
      actualValue === undefined ||
      component === undefined ||
      limit === undefined
    ) {
      throw new Error(`${scenarioId} ${label} missing component at index=${componentIndex}`);
    }
    const drift = Math.abs(actualValue - expectedValue);
    if (!Number.isFinite(drift) || drift > limit) {
      throw new Error(
        `${scenarioId} ${label} drift: component=${component}, expected=${expectedValue}, actual=${actualValue}, drift=${drift}, limit=${limit}`,
      );
    }
  }
}

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
  assertScalarMatches(
    expected.scenarioId,
    'schemaVersion',
    actual.schemaVersion,
    expected.schemaVersion,
  );
  assertScalarMatches(expected.scenarioId, 'epoch', actual.epoch, expected.epoch);
  assertScalarMatches(expected.scenarioId, 'durationSec', actual.durationSec, expected.durationSec);
  assertScalarMatches(
    expected.scenarioId,
    'sampleIntervalSec',
    actual.sampleIntervalSec,
    expected.sampleIntervalSec,
  );
  assertScalarMatches(
    expected.scenarioId,
    'integration.profile',
    actual.integration.profile,
    expected.integration.profile,
  );
  assertScalarMatches(
    expected.scenarioId,
    'integration.maxAcceptedStepsPerSegment',
    actual.integration.maxAcceptedStepsPerSegment,
    expected.integration.maxAcceptedStepsPerSegment,
  );
  assertParametersMatch(actual, expected);
  const limits = componentLimits(expected.scenarioId);
  assertStateMatches(
    expected.scenarioId,
    'initialState',
    actual.initialState,
    expected.initialState,
    limits,
  );
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
      const limit = limits[componentIndex];
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
