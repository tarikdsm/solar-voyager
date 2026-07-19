import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { APPLICATION_SMOKE_FIRST_FRAME_TIMEOUT_MS } from './applicationSmokeContract.mjs';

const CI_APPLICATION_SMOKE_STEP_TIMEOUT_MS = 300_000;
const CI_TEARDOWN_HEADROOM_MS = 120_000;

function smokeStep(name) {
  const workflow = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
  const step = workflow.jobs.check.steps.find((candidate) => candidate.name === name);
  if (step === undefined) throw new Error(`${name} CI step is missing`);
  return step;
}

describe('application smoke timeout policy', () => {
  it('allows the measured SwiftShader first frame while preserving CI hang headroom', () => {
    const productionStep = smokeStep('Application smoke');
    expect(productionStep.run).toBe('npm run test:smoke -- --production-only');
    expect(productionStep['timeout-minutes']).toBe(5);
    expect(APPLICATION_SMOKE_FIRST_FRAME_TIMEOUT_MS).toBe(180_000);
    expect(APPLICATION_SMOKE_FIRST_FRAME_TIMEOUT_MS).toBeLessThanOrEqual(
      productionStep['timeout-minutes'] * 60_000 - CI_TEARDOWN_HEADROOM_MS,
    );
    expect(APPLICATION_SMOKE_FIRST_FRAME_TIMEOUT_MS).toBeLessThan(
      CI_APPLICATION_SMOKE_STEP_TIMEOUT_MS,
    );
  });
});
