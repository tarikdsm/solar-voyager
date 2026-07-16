import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { format, resolveConfig } from 'prettier';
import { describe, expect, it } from 'vitest';

import {
  GOLDEN_SCENARIO_IDS,
  createGoldenScenario,
  runGoldenTrajectory,
} from './goldenTrajectoryHarness.js';

const regenerationEnabled = process.env.SOLAR_VOYAGER_UPDATE_GOLDENS === 'explicitly-approved';

describe.skipIf(!regenerationEnabled)('explicit golden trajectory regeneration', () => {
  for (const scenarioId of GOLDEN_SCENARIO_IDS) {
    it(`writes ${scenarioId}.json`, async () => {
      const trajectory = runGoldenTrajectory(createGoldenScenario(scenarioId));
      const outputUrl = new URL(`${scenarioId}.json`, import.meta.url);
      const outputPath = fileURLToPath(outputUrl);
      const prettierConfig = await resolveConfig(outputPath);
      const json = await format(JSON.stringify(trajectory), {
        ...prettierConfig,
        filepath: outputPath,
      });

      writeFileSync(outputPath, json, 'utf8');

      expect(trajectory.samples).toHaveLength(31);
    });
  }
});
