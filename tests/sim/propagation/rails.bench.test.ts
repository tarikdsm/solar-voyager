import { describe, expect, it } from 'vitest';

import {
  compileRailsCatalog,
  createRailsState,
  createRailsWorkspace,
  evaluateRailsInto,
  type RailsBodyInput,
} from '../../../src/sim/propagation/rails.js';

const BODY_COUNT = 50;
const WARMUP_EVALUATIONS = 500;
const SAMPLE_COUNT = 9;
const EVALUATIONS_PER_SAMPLE = 1_000;
const MAX_MEDIAN_MS = 0.2;

function syntheticCatalog(): RailsBodyInput[] {
  const bodies: RailsBodyInput[] = [
    { id: 'sun', parentId: null, muKm3S2: 132_712_440_041.9394, elements: null },
  ];
  for (let index = 1; index < BODY_COUNT; index += 1) {
    bodies.push({
      id: `body${index}`,
      parentId: 'sun',
      muKm3S2: 1 + index,
      elements: {
        semiMajorAxisKm: 50_000_000 + index * 5_000_000,
        eccentricity: 0.01 + (index % 49) * 0.01,
        inclinationRad: 0.001 * index,
        longitudeAscendingNodeRad: 0.01 * index,
        argumentPeriapsisRad: 0.02 * index,
        meanAnomalyRad: 0.03 * index,
      },
    });
  }
  return bodies;
}

describe('rails performance budget', () => {
  it('evaluates 50 changing-time body states below 0.2 ms median', () => {
    const catalog = compileRailsCatalog(syntheticCatalog());
    const state = createRailsState(catalog);
    const workspace = createRailsWorkspace();
    let timeSec = 0;

    for (let index = 0; index < WARMUP_EVALUATIONS; index += 1) {
      timeSec += 60;
      evaluateRailsInto(state, catalog, timeSec, workspace);
    }

    const samplesMs = new Float64Array(SAMPLE_COUNT);
    for (let sampleIndex = 0; sampleIndex < SAMPLE_COUNT; sampleIndex += 1) {
      const startMs = performance.now();
      for (let index = 0; index < EVALUATIONS_PER_SAMPLE; index += 1) {
        timeSec += 60;
        evaluateRailsInto(state, catalog, timeSec, workspace);
      }
      samplesMs[sampleIndex] = (performance.now() - startMs) / EVALUATIONS_PER_SAMPLE;
    }

    samplesMs.sort();
    const medianMs = samplesMs[Math.floor(SAMPLE_COUNT / 2)] as number;
    process.stdout.write(`rails benchmark: ${medianMs.toFixed(6)} ms / 50 bodies\n`);
    expect(medianMs, `median ${medianMs.toFixed(6)} ms`).toBeLessThan(MAX_MEDIAN_MS);
  });
});
