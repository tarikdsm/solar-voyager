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
const CALIBRATED_DWARF_AND_LOCAL_MOON_IDS = new Set([
  'phobos',
  'deimos',
  'pluto',
  'charon',
  'ceres',
  'eris',
  'makemake',
  'haumea',
]);
const CALIBRATED_GIANT_MOON_IDS = new Set([
  'io',
  'europa',
  'ganymede',
  'callisto',
  'mimas',
  'enceladus',
  'tethys',
  'dione',
  'rhea',
  'titan',
  'iapetus',
  'miranda',
  'ariel',
  'umbriel',
  'titania',
  'oberon',
  'triton',
]);
const CALIBRATED_SMALL_BODY_IDS = new Set([
  'vesta',
  'pallas',
  'hygiea',
  'eros',
  'bennu',
  'ryugu',
  '1p',
  '67p',
]);

interface CheckState {
  readonly positionKm: readonly number[];
  readonly velocityKmS: readonly number[];
}

interface CheckSample {
  readonly offsetDays: number;
  readonly states: Readonly<Record<string, CheckState>>;
}

interface AccuracyLimit {
  readonly positionKm: number;
  readonly velocityKmS: number;
}

type AccuracyClass = 'planet' | 'local' | 'giantMoon' | 'small';

const ACCURACY_LIMITS: Readonly<Record<AccuracyClass, readonly [AccuracyLimit, AccuracyLimit]>> = {
  planet: [
    { positionKm: 38_000, velocityKmS: 0.042 },
    { positionKm: 1_300_000, velocityKmS: 0.28 },
  ],
  local: [
    { positionKm: 72_000, velocityKmS: 1.1 },
    { positionKm: 900_000, velocityKmS: 2.1 },
  ],
  giantMoon: [
    { positionKm: 210_000, velocityKmS: 17 },
    { positionKm: 710_000, velocityKmS: 28 },
  ],
  small: [
    { positionKm: 3_800, velocityKmS: 0.003 },
    { positionKm: 710_000, velocityKmS: 0.053 },
  ],
};

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

function velocityErrorKmS(state: RailsState, bodyIndex: number, expected: CheckState): number {
  const componentIndex = bodyIndex * 3;
  return Math.hypot(
    (state.velocitiesKmS[componentIndex] as number) - (expected.velocityKmS[0] as number),
    (state.velocitiesKmS[componentIndex + 1] as number) - (expected.velocityKmS[1] as number),
    (state.velocitiesKmS[componentIndex + 2] as number) - (expected.velocityKmS[2] as number),
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

function accuracyClassForBody(bodyId: string): AccuracyClass {
  if (bodyId === 'moon' || CALIBRATED_PLANET_IDS.has(bodyId)) {
    return 'planet';
  }
  if (CALIBRATED_DWARF_AND_LOCAL_MOON_IDS.has(bodyId)) {
    return 'local';
  }
  if (CALIBRATED_GIANT_MOON_IDS.has(bodyId)) {
    return 'giantMoon';
  }
  if (CALIBRATED_SMALL_BODY_IDS.has(bodyId)) {
    return 'small';
  }
  throw new Error(`rails accuracy bound has not been calibrated for ${bodyId}`);
}

function accuracyLimit(bodyId: string, sampleIndex: number): AccuracyLimit {
  if (sampleIndex !== 1 && sampleIndex !== 2) {
    throw new RangeError(`rails accuracy sample index must be 1 or 2, received ${sampleIndex}`);
  }
  if (bodyId === 'sun') {
    return { positionKm: 0, velocityKmS: 0 };
  }
  const limits = ACCURACY_LIMITS[accuracyClassForBody(bodyId)];
  return sampleIndex === 1 ? limits[0] : limits[1];
}

describe('rails vs JPL Horizons — physics-spec.md §2', () => {
  it('pins the J2026, +30 day, and +365 day check epochs', () => {
    expect(samples.map(({ offsetDays }) => offsetDays)).toEqual([0, 30, 365]);
  });

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
      for (let bodyIndex = 0; bodyIndex < catalog.bodyCount; bodyIndex += 1) {
        const bodyId = catalog.bodyIds[bodyIndex] as string;
        const expected = sample.states[bodyId] as CheckState;
        const limit = accuracyLimit(bodyId, sampleIndex);
        const positionError = positionErrorKm(state, bodyIndex, expected);
        const velocityError = velocityErrorKmS(state, bodyIndex, expected);

        if (bodyId === 'sun') {
          expect(positionError, `${bodyId} position @ +${sample.offsetDays} d`).toBe(0);
          expect(velocityError, `${bodyId} velocity @ +${sample.offsetDays} d`).toBe(0);
        } else {
          expect(positionError, `${bodyId} position @ +${sample.offsetDays} d`).toBeLessThan(
            limit.positionKm,
          );
          expect(velocityError, `${bodyId} velocity @ +${sample.offsetDays} d`).toBeLessThan(
            limit.velocityKmS,
          );
        }
      }
    },
  );

  it('fails closed when a newly baked body has no calibrated accuracy bound', () => {
    expect(() => accuracyLimit('newbody', 1)).toThrow(/has not been calibrated for newbody/u);
  });
});
