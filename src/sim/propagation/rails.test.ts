import { describe, expect, it } from 'vitest';

import type { OrbitalElements } from '../bodies/orbitalElements.js';
import { compileRailsCatalog, type RailsBodyInput } from './rails.js';

function orbit(semiMajorAxisKm = 100, eccentricity = 0.1): OrbitalElements {
  return {
    semiMajorAxisKm,
    eccentricity,
    inclinationRad: 0.2,
    longitudeAscendingNodeRad: 0.3,
    argumentPeriapsisRad: 0.4,
    meanAnomalyRad: 0.5,
  };
}

function nestedBodies(): RailsBodyInput[] {
  return [
    { id: 'sun', parentId: null, muKm3S2: 1_000, elements: null },
    { id: 'planet', parentId: 'sun', muKm3S2: 10, elements: orbit(100) },
    { id: 'moon', parentId: 'planet', muKm3S2: 1, elements: orbit(10, 0.01) },
  ];
}

describe('rails catalog compiler — physics-spec.md §2', () => {
  it('compiles parent-first catalog data into float64 structure-of-arrays storage', () => {
    const catalog = compileRailsCatalog(nestedBodies());

    expect(catalog.bodyCount).toBe(3);
    expect(catalog.bodyIds).toEqual(['sun', 'planet', 'moon']);
    expect(catalog.parentIndices).toBeInstanceOf(Int32Array);
    expect([...catalog.parentIndices]).toEqual([-1, 0, 1]);
    expect(catalog.muKm3S2).toBeInstanceOf(Float64Array);
    expect([...catalog.muKm3S2]).toEqual([1_000, 10, 1]);
    expect([...catalog.parentMuKm3S2]).toEqual([0, 1_000, 10]);
    expect(catalog.semiMajorAxisKm[2]).toBe(10);
    expect(catalog.eccentricity[2]).toBe(0.01);
    expect(catalog.meanMotionRadS[2]).toBeCloseTo(Math.sqrt(10 / 10 ** 3), 15);
  });

  it.each([
    ['an empty catalog', (): RailsBodyInput[] => [], /at least one body/u],
    [
      'a duplicate id',
      (): RailsBodyInput[] => {
        const bodies = nestedBodies();
        bodies[2] = { ...bodies[2], id: 'planet' } as RailsBodyInput;
        return bodies;
      },
      /duplicate body id/u,
    ],
    [
      'a non-root first body',
      (): RailsBodyInput[] => nestedBodies().slice(1),
      /first body must be the root/u,
    ],
    [
      'a second root',
      (): RailsBodyInput[] => [
        ...nestedBodies(),
        { id: 'otherroot', parentId: null, muKm3S2: 1, elements: null },
      ],
      /only the first body may be the root/u,
    ],
    [
      'a missing parent',
      (): RailsBodyInput[] => {
        const bodies = nestedBodies();
        bodies[1] = { ...bodies[1], parentId: 'missing' } as RailsBodyInput;
        return bodies;
      },
      /parent missing must precede planet/u,
    ],
    [
      'a forward parent',
      (): RailsBodyInput[] => {
        const bodies = nestedBodies();
        bodies[1] = { ...bodies[1], parentId: 'moon' } as RailsBodyInput;
        return bodies;
      },
      /parent moon must precede planet/u,
    ],
    [
      'null non-root elements',
      (): RailsBodyInput[] => {
        const bodies = nestedBodies();
        bodies[1] = { ...bodies[1], elements: null } as RailsBodyInput;
        return bodies;
      },
      /planet must have orbital elements/u,
    ],
    [
      'root elements',
      (): RailsBodyInput[] => {
        const bodies = nestedBodies();
        bodies[0] = { ...bodies[0], elements: orbit() } as RailsBodyInput;
        return bodies;
      },
      /root body must not have orbital elements/u,
    ],
    [
      'non-positive GM',
      (): RailsBodyInput[] => {
        const bodies = nestedBodies();
        bodies[1] = { ...bodies[1], muKm3S2: 0 } as RailsBodyInput;
        return bodies;
      },
      /planet GM must be finite and positive/u,
    ],
    [
      'a non-finite angle',
      (): RailsBodyInput[] => {
        const bodies = nestedBodies();
        bodies[1] = {
          ...bodies[1],
          elements: { ...orbit(), inclinationRad: Number.NaN },
        } as RailsBodyInput;
        return bodies;
      },
      /planet orbital elements must be finite/u,
    ],
    [
      'an elliptic orbit with negative semimajor axis',
      (): RailsBodyInput[] => {
        const bodies = nestedBodies();
        bodies[1] = { ...bodies[1], elements: orbit(-100, 0.5) } as RailsBodyInput;
        return bodies;
      },
      /planet has an invalid elliptic or hyperbolic branch/u,
    ],
    [
      'a hyperbolic orbit with positive semimajor axis',
      (): RailsBodyInput[] => {
        const bodies = nestedBodies();
        bodies[1] = { ...bodies[1], elements: orbit(100, 1.5) } as RailsBodyInput;
        return bodies;
      },
      /planet has an invalid elliptic or hyperbolic branch/u,
    ],
    [
      'a parabolic orbit',
      (): RailsBodyInput[] => {
        const bodies = nestedBodies();
        bodies[1] = { ...bodies[1], elements: orbit(100, 1) } as RailsBodyInput;
        return bodies;
      },
      /planet has an invalid elliptic or hyperbolic branch/u,
    ],
  ])('rejects %s', (_label, makeBodies, expectedMessage) => {
    expect(() => compileRailsCatalog(makeBodies())).toThrow(expectedMessage);
  });
});

