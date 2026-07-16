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
  'jupiter',
  'saturn',
  'uranus',
  'neptune',
];

function readJson(name: string): unknown {
  return JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8')) as unknown;
}

const schema = readJson('bodies.schema.json');
const catalog = readJson('bodies.json') as {
  frame: string;
  bodies: Array<{
    id: string;
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
      elementsToStateInto(converted, body.elements, parent?.muKm3S2 as number, scratch);
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
