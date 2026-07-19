import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

import {
  APPLICATION_SMOKE_FIRST_FRAME_TIMEOUT_MS,
  installProductionSmokeRafFreeze,
} from './applicationSmokeContract.mjs';

const CI_APPLICATION_SMOKE_STEP_TIMEOUT_MS = 300_000;
const CI_TEARDOWN_HEADROOM_MS = 120_000;

function smokeStep(name) {
  const workflow = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
  const step = workflow.jobs.check.steps.find((candidate) => candidate.name === name);
  if (step === undefined) throw new Error(`${name} CI step is missing`);
  return step;
}

describe('application smoke timeout policy', () => {
  it('bounds the frozen production probe while preserving CI hang headroom', () => {
    const productionStep = smokeStep('Application smoke');
    expect(productionStep.run).toBe('npm run test:smoke -- --production-only');
    expect(productionStep['timeout-minutes']).toBe(5);
    expect(APPLICATION_SMOKE_FIRST_FRAME_TIMEOUT_MS).toBe(60_000);
    expect(APPLICATION_SMOKE_FIRST_FRAME_TIMEOUT_MS).toBeLessThanOrEqual(
      productionStep['timeout-minutes'] * 60_000 - CI_TEARDOWN_HEADROOM_MS,
    );
    expect(APPLICATION_SMOKE_FIRST_FRAME_TIMEOUT_MS).toBeLessThan(
      CI_APPLICATION_SMOKE_STEP_TIMEOUT_MS,
    );
  });

  it('runs native callbacks until one telemetry sample exists, then ignores later scheduling', () => {
    const callbacks = [];
    const canvas = { solarVoyagerTelemetry: { frameSampleCount: 0 } };
    const target = {
      document: { querySelector: () => canvas },
      requestAnimationFrame: (callback) => {
        callbacks.push(callback);
        return callbacks.length;
      },
    };
    const firstCallback = vi.fn();

    installProductionSmokeRafFreeze(target);
    const diagnostics = target.__solarVoyagerSmokeRafFreeze;
    expect(target.requestAnimationFrame(firstCallback)).toBe(1);
    expect(firstCallback).not.toHaveBeenCalled();
    expect(callbacks).toHaveLength(1);
    expect(diagnostics).toEqual({
      completedFrameObserved: false,
      ignoredScheduleCount: 0,
      nativeScheduleCount: 1,
    });

    callbacks.shift()(16);
    expect(firstCallback).toHaveBeenCalledOnce();
    canvas.solarVoyagerTelemetry.frameSampleCount = 1;
    expect(target.requestAnimationFrame(firstCallback)).toBe(0);
    expect(callbacks).toHaveLength(0);
    expect(firstCallback).toHaveBeenCalledOnce();
    expect(target.__solarVoyagerSmokeRafFreeze).toBe(diagnostics);
    expect(diagnostics).toEqual({
      completedFrameObserved: true,
      ignoredScheduleCount: 1,
      nativeScheduleCount: 1,
    });
  });
});
