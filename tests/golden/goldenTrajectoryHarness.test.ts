import { describe, expect, it } from 'vitest';

import {
  GOLDEN_DURATION_SEC,
  GOLDEN_SAMPLE_INTERVAL_SEC,
  GOLDEN_SCENARIO_IDS,
  createGoldenScenario,
  runGoldenTrajectory,
} from './goldenTrajectoryHarness.js';

describe('golden trajectory harness - physics-spec.md section 7.6', () => {
  it('constructs the three recorded J2026 scenarios deterministically', () => {
    expect(GOLDEN_SCENARIO_IDS).toEqual([
      'leo-30d',
      'earth-mars-transfer-30d',
      'jupiter-flyby-30d',
    ]);

    for (const scenarioId of GOLDEN_SCENARIO_IDS) {
      const first = createGoldenScenario(scenarioId);
      const second = createGoldenScenario(scenarioId);

      expect(first.id).toBe(scenarioId);
      expect(first.epoch).toBe('J2026');
      expect(first.parameters).not.toEqual({});
      expect([...first.initialState]).toEqual([...second.initialState]);
      expect([...first.initialState].every(Number.isFinite)).toBe(true);
      expect(first.initialState).toHaveLength(7);
    }
  });

  it('produces 31 finite daily samples through day 30', () => {
    const trajectory = runGoldenTrajectory(createGoldenScenario('earth-mars-transfer-30d'));

    expect(trajectory.durationSec).toBe(GOLDEN_DURATION_SEC);
    expect(trajectory.sampleIntervalSec).toBe(GOLDEN_SAMPLE_INTERVAL_SEC);
    expect(trajectory.samples).toHaveLength(31);
    expect(trajectory.samples[0]?.timeSec).toBe(0);
    expect(trajectory.samples.at(-1)?.timeSec).toBe(GOLDEN_DURATION_SEC);
    for (const sample of trajectory.samples) {
      expect(sample.state).toHaveLength(7);
      expect(sample.state.every(Number.isFinite)).toBe(true);
    }
  });

  it('fails loudly when a daily segment exhausts its accepted-step budget', () => {
    expect(() =>
      runGoldenTrajectory(createGoldenScenario('leo-30d'), { maxAcceptedSteps: 1 }),
    ).toThrow(/leo-30d.*day 1.*budgetExhausted=true.*accepted=1/u);
  });
});
