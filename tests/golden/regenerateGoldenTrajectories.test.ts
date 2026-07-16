import { writeFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  GOLDEN_SCENARIO_IDS,
  createGoldenScenario,
  runGoldenTrajectory,
} from './goldenTrajectoryHarness.js';

const regenerationEnabled = process.env.SOLAR_VOYAGER_UPDATE_GOLDENS === 'explicitly-approved';

describe.skipIf(!regenerationEnabled)('explicit golden trajectory regeneration', () => {
  for (const scenarioId of GOLDEN_SCENARIO_IDS) {
    it(`writes ${scenarioId}.json`, () => {
      const trajectory = runGoldenTrajectory(createGoldenScenario(scenarioId));
      const outputUrl = new URL(`${scenarioId}.json`, import.meta.url);

      writeFileSync(outputUrl, `${JSON.stringify(trajectory, null, 2)}\n`, 'utf8');

      expect(trajectory.samples).toHaveLength(31);
    });
  }
});
