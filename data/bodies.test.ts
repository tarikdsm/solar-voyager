import { readFileSync } from 'node:fs';

import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';

import {
  createCartesianState,
  createOrbitalConversionScratch,
  elementsToStateInto,
  type OrbitalElements,
} from '../src/sim/bodies/orbitalElements.js';

const BODY_IDS = [
  'sun',
  'mercury',
  'venus',
  'earth',
  'moon',
  'mars',
  'phobos',
  'deimos',
  'jupiter',
  'io',
  'europa',
  'ganymede',
  'callisto',
  'saturn',
  'mimas',
  'enceladus',
  'tethys',
  'dione',
  'rhea',
  'titan',
  'iapetus',
  'uranus',
  'miranda',
  'ariel',
  'umbriel',
  'titania',
  'oberon',
  'neptune',
  'triton',
  'pluto',
  'charon',
  'ceres',
  'eris',
  'makemake',
  'haumea',
  'vesta',
  'pallas',
  'hygiea',
  'eros',
  'bennu',
  'ryugu',
  '1p',
  '67p',
];

function readJson(name: string): unknown {
  return JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8')) as unknown;
}

const schema = readJson('bodies.schema.json');
const catalog = readJson('bodies.json') as {
  frame: string;
  bodies: Array<{
    id: string;
    horizonsId: number;
    parentId: string | null;
    soiRadiusKm: number | null;
    muKm3S2: number;
    elements: OrbitalElements | null;
  }>;
};
const checks = readJson('ephemerides-check.json') as {
  frame: string;
  samples: Array<{
    offsetDays: number;
    states: Record<string, { positionKm: number[]; velocityKmS: number[] }>;
  }>;
};

describe('body catalog - physics-spec.md section 2', () => {
  it('validates against the versioned JSON Schema', () => {
    const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);

    expect(validate(catalog), JSON.stringify(validate.errors, null, 2)).toBe(true);
  });

  it('accepts the catalog kinds and hyperbolic elements required by T0021', () => {
    const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
    const template = catalog.bodies.find((body) => body.id === 'earth');
    const sun = catalog.bodies.find((body) => body.id === 'sun');
    expect(template).toBeDefined();
    expect(sun).toBeDefined();

    for (const kind of ['dwarf', 'asteroid', 'comet']) {
      const candidate = structuredClone(template) as Record<string, unknown>;
      candidate.id = `test${kind}`;
      candidate.kind = kind;
      if (kind === 'comet') {
        candidate.elements = {
          ...(candidate.elements as Record<string, unknown>),
          semiMajorAxisKm: -1,
          eccentricity: 1.1,
        };
      }
      expect(
        validate({ ...catalog, bodies: [sun, candidate] }),
        JSON.stringify(validate.errors),
      ).toBe(true);
    }
  });

  it('rejects parabolic or sign-inconsistent element branches', () => {
    const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
    const sun = catalog.bodies.find((body) => body.id === 'sun');
    const template = structuredClone(catalog.bodies.find((body) => body.id === 'earth')) as Record<
      string,
      unknown
    >;
    for (const [semiMajorAxisKm, eccentricity] of [
      [-1, 0.9],
      [1, 1.1],
      [0, 0.9],
      [-1, 1],
    ]) {
      const candidate = structuredClone(template);
      candidate.elements = {
        ...(candidate.elements as Record<string, unknown>),
        semiMajorAxisKm,
        eccentricity,
      };
      expect(validate({ ...catalog, bodies: [sun, candidate] })).toBe(false);
    }
  });

  it('requires exactly one valid root and complete non-root orbital fields', () => {
    const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
    const mercury = structuredClone(catalog.bodies.find((body) => body.id === 'mercury')) as Record<
      string,
      unknown
    >;
    const sun = catalog.bodies.find((body) => body.id === 'sun');

    for (const field of ['parentId', 'elements', 'soiRadiusKm']) {
      const invalid = structuredClone(mercury);
      invalid[field] = null;
      expect(validate({ ...catalog, bodies: [sun, invalid] }), field).toBe(false);
    }
    expect(validate({ ...catalog, bodies: [mercury] }), 'missing Sun root').toBe(false);
    expect(catalog.bodies.filter((body) => body.parentId === null).map((body) => body.id)).toEqual([
      'sun',
    ]);
    expect(new Set(catalog.bodies.map((body) => body.id)).size).toBe(catalog.bodies.length);
  });

  it('keeps canonical order and parent-before-child topology', () => {
    expect(catalog.bodies.map((body) => body.id)).toEqual(BODY_IDS);
    const seen = new Set<string>();
    for (const body of catalog.bodies) {
      if (body.parentId !== null) {
        expect(seen.has(body.parentId), `${body.id} parent ${body.parentId}`).toBe(true);
        expect(body.elements).not.toBeNull();
        expect(body.soiRadiusKm).toBeGreaterThan(0);
      }
      seen.add(body.id);
    }
  });

  it('contains finite heliocentric checks for every body at all epochs', () => {
    expect(checks.frame).toBe('heliocentric-ecliptic-j2000');
    expect(checks.samples.map((sample) => sample.offsetDays)).toEqual([0, 30, 365]);
    for (const sample of checks.samples) {
      expect(Object.keys(sample.states)).toEqual(BODY_IDS);
      for (const bodyId of BODY_IDS) {
        const state = sample.states[bodyId];
        expect(state.positionKm).toHaveLength(3);
        expect(state.velocityKmS).toHaveLength(3);
        expect([...state.positionKm, ...state.velocityKmS].every(Number.isFinite)).toBe(true);
      }
      expect(sample.states.sun).toEqual({
        positionKm: [0, 0, 0],
        velocityKmS: [0, 0, 0],
      });
    }
  });

  it('stores Moon elements parent-relative while checks stay heliocentric', () => {
    const moon = catalog.bodies.find((body) => body.id === 'moon');
    expect(moon?.parentId).toBe('earth');
    expect(moon?.elements).not.toBeNull();
    expect(catalog.frame).toBe('heliocentric-ecliptic-j2000');
    expect(checks.frame).toBe(catalog.frame);
  });

  it('keeps both pinned comet solutions on their real elliptic branches', () => {
    for (const [bodyId, horizonsId] of [
      ['1p', 90_000_030],
      ['67p', 90_000_702],
    ] as const) {
      const comet = catalog.bodies.find((body) => body.id === bodyId);
      expect(comet?.horizonsId).toBe(horizonsId);
      expect(comet?.elements?.semiMajorAxisKm).toBeGreaterThan(0);
      expect(comet?.elements?.eccentricity).toBeGreaterThanOrEqual(0);
      expect(comet?.elements?.eccentricity).toBeLessThan(1);
    }
  });

  it('reconstructs epoch states within one kilometer of independent Horizons vectors', () => {
    const epochStates = checks.samples[0].states;
    const bodyById = new Map(catalog.bodies.map((body) => [body.id, body]));
    const converted = createCartesianState();
    const scratch = createOrbitalConversionScratch();

    for (const body of catalog.bodies) {
      if (body.parentId === null || body.elements === null) {
        continue;
      }
      const parent = bodyById.get(body.parentId);
      expect(parent).toBeDefined();
      elementsToStateInto(
        converted,
        body.elements,
        (parent?.muKm3S2 as number) + body.muKm3S2,
        scratch,
      );
      const parentState = epochStates[body.parentId];
      const expected = epochStates[body.id];
      const positionErrorKm = Math.hypot(
        converted.positionKm.x + parentState.positionKm[0] - expected.positionKm[0],
        converted.positionKm.y + parentState.positionKm[1] - expected.positionKm[1],
        converted.positionKm.z + parentState.positionKm[2] - expected.positionKm[2],
      );

      expect(positionErrorKm, body.id).toBeLessThan(1);
    }
  });
});
