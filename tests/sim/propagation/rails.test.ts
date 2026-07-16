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
const CALIBRATED_PLANET_IDS = new Set([
  'mercury',
  'venus',
  'earth',
  'mars',
  'jupiter',
  'saturn',
  'uranus',
  'neptune',
]);

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

function positionLimitKm(bodyId: string, sampleIndex: number): number {
  if (bodyId === 'sun') {
    return 0;
  }
  if (bodyId === 'moon' || CALIBRATED_PLANET_IDS.has(bodyId)) {
    return sampleIndex === 1 ? 50_000 : 1_500_000;
  }
  throw new Error(`rails accuracy bound has not been calibrated for ${bodyId}`);
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

  it.each([{ sampleIndex: 1 }, { sampleIndex: 2 }])(
    'stays inside class error bounds at sample $sampleIndex',
    ({ sampleIndex }) => {
      const sample = samples[sampleIndex] as CheckSample;
      const state = evaluateSample(sample);
      const errorsKm = catalog.bodyIds.map((bodyId, bodyIndex) =>
        positionErrorKm(state, bodyIndex, sample.states[bodyId] as CheckState),
      );
      for (let bodyIndex = 0; bodyIndex < catalog.bodyCount; bodyIndex += 1) {
        const bodyId = catalog.bodyIds[bodyIndex] as string;
        const errorKm = errorsKm[bodyIndex] as number;
        const limitKm = positionLimitKm(bodyId, sampleIndex);
        if (limitKm === 0) {
          expect(errorKm, bodyId).toBe(0);
        } else {
          expect(errorKm, bodyId).toBeLessThan(limitKm);
        }
      }
    },
  );

  it('fails closed when a newly baked body has no calibrated accuracy bound', () => {
    expect(() => positionLimitKm('io', 1)).toThrow(/has not been calibrated for io/u);
    expect(() => positionLimitKm('67p', 2)).toThrow(/has not been calibrated for 67p/u);
  });
});
