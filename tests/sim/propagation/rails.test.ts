import { describe, expect, it } from 'vitest';

import bodiesDocument from '../../../data/bodies.json';
import checksDocument from '../../../data/ephemerides-check.json';
import {
  compileRailsCatalog,
  createRailsState,
  createRailsWorkspace,
  evaluateRailsInto,
  type RailsBodyInput,
  type RailsState,
} from '../../../src/sim/propagation/rails.js';

const DAY_SEC = 86_400;

interface CheckState {
  readonly positionKm: readonly number[];
  readonly velocityKmS: readonly number[];
}

interface CheckSample {
  readonly offsetDays: number;
  readonly states: Readonly<Record<string, CheckState>>;
}

const inputs: RailsBodyInput[] = bodiesDocument.bodies.map((body) => ({
  id: body.id,
  parentId: body.parentId,
  muKm3S2: body.muKm3S2,
  elements: body.elements,
}));
const catalog = compileRailsCatalog(inputs);
const samples = checksDocument.samples as CheckSample[];

function positionErrorKm(state: RailsState, bodyIndex: number, expected: CheckState): number {
  const componentIndex = bodyIndex * 3;
  return Math.hypot(
    (state.positionsKm[componentIndex] as number) - (expected.positionKm[0] as number),
    (state.positionsKm[componentIndex + 1] as number) - (expected.positionKm[1] as number),
    (state.positionsKm[componentIndex + 2] as number) - (expected.positionKm[2] as number),
  );
}

function evaluateSample(sample: CheckSample): RailsState {
  return evaluateRailsInto(
    createRailsState(catalog),
    catalog,
    sample.offsetDays * DAY_SEC,
    createRailsWorkspace(),
  );
}

describe('rails vs JPL Horizons — physics-spec.md §2', () => {
  it('matches every baked body position within one kilometer at J2026', () => {
    const sample = samples[0] as CheckSample;
    const state = evaluateSample(sample);

    for (let bodyIndex = 0; bodyIndex < catalog.bodyCount; bodyIndex += 1) {
      const bodyId = catalog.bodyIds[bodyIndex] as string;
      const expected = sample.states[bodyId] as CheckState;
      expect(positionErrorKm(state, bodyIndex, expected), bodyId).toBeLessThan(1);
    }
  });

  it.each([
    { sampleIndex: 1, planetLimitKm: 50_000, moonLimitKm: 50_000 },
    { sampleIndex: 2, planetLimitKm: 1_500_000, moonLimitKm: 1_500_000 },
  ])(
    'stays inside class error bounds at sample $sampleIndex',
    ({ sampleIndex, planetLimitKm, moonLimitKm }) => {
      const sample = samples[sampleIndex] as CheckSample;
      const state = evaluateSample(sample);
      const errorsKm = catalog.bodyIds.map((bodyId, bodyIndex) =>
        positionErrorKm(state, bodyIndex, sample.states[bodyId] as CheckState),
      );
      for (let bodyIndex = 0; bodyIndex < catalog.bodyCount; bodyIndex += 1) {
        const bodyId = catalog.bodyIds[bodyIndex] as string;
        const errorKm = errorsKm[bodyIndex] as number;
        if (bodyId === 'sun') {
          expect(errorKm, bodyId).toBe(0);
        } else if (bodyId === 'moon') {
          expect(errorKm, bodyId).toBeLessThan(moonLimitKm);
        } else {
          expect(errorKm, bodyId).toBeLessThan(planetLimitKm);
        }
      }
    },
  );
});
