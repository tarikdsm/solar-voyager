import { readFileSync } from 'node:fs';

import { describe, it } from 'vitest';

import { assertGoldenTrajectoryMatches } from './goldenComparison.js';
import {
  GOLDEN_SCENARIO_IDS,
  createGoldenScenario,
  runGoldenTrajectory,
  type GoldenTrajectory,
} from './goldenTrajectoryHarness.js';

function readGolden(scenarioId: string): GoldenTrajectory {
  return JSON.parse(
    readFileSync(new URL(`${scenarioId}.json`, import.meta.url), 'utf8'),
  ) as GoldenTrajectory;
}

describe('30-day golden trajectories - physics-spec.md section 7.6', () => {
  for (const scenarioId of GOLDEN_SCENARIO_IDS) {
    it(`keeps ${scenarioId} within component drift limits`, () => {
      const expected = readGolden(scenarioId);
      const actual = runGoldenTrajectory(createGoldenScenario(scenarioId));

      assertGoldenTrajectoryMatches(actual, expected);
    }, 20_000);
  }
});
