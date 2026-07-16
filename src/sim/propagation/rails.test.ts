import { describe, expect, it } from 'vitest';

import {
  createCartesianState,
  createOrbitalConversionScratch,
  elementsToStateInto,
  type OrbitalElements,
} from '../bodies/orbitalElements.js';
import {
  compileRailsCatalog,
  createRailsState,
  createRailsWorkspace,
  evaluateRailsInto,
  type RailsBodyInput,
  type RailsState,
} from './rails.js';

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
    expect([...catalog.orbitalMuKm3S2]).toEqual([0, 1_010, 11]);
    expect(catalog.semiMajorAxisKm[2]).toBe(10);
    expect(catalog.eccentricity[2]).toBe(0.01);
    expect(catalog.meanMotionRadS[2]).toBeCloseTo(Math.sqrt((10 + 1) / 10 ** 3), 15);
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

describe('rails state evaluation — physics-spec.md §2', () => {
  function circularOrbit(semiMajorAxisKm: number): OrbitalElements {
    return {
      ...orbit(semiMajorAxisKm, 0),
      inclinationRad: 0,
      longitudeAscendingNodeRad: 0,
      argumentPeriapsisRad: 0,
      meanAnomalyRad: 0,
    };
  }

  function circularNestedBodies(): RailsBodyInput[] {
    return [
      { id: 'sun', parentId: null, muKm3S2: 1_000, elements: null },
      { id: 'planet', parentId: 'sun', muKm3S2: 10, elements: circularOrbit(100) },
      { id: 'moon', parentId: 'planet', muKm3S2: 1, elements: circularOrbit(10) },
    ];
  }

  it('composes nested parent-relative states in one parent-first pass', () => {
    const catalog = compileRailsCatalog(circularNestedBodies());
    const state = createRailsState(catalog);
    const positions = state.positionsKm;
    const velocities = state.velocitiesKmS;

    expect(evaluateRailsInto(state, catalog, 0, createRailsWorkspace())).toBe(state);
    expect(state.timeSec).toBe(0);
    expect(state.positionsKm).toBe(positions);
    expect(state.velocitiesKmS).toBe(velocities);
    expect([...state.positionsKm]).toEqual([0, 0, 0, 100, 0, 0, 110, 0, 0]);
    expect(state.velocitiesKmS[0]).toBe(0);
    expect(state.velocitiesKmS[1]).toBe(0);
    expect(state.velocitiesKmS[2]).toBe(0);
    expect(state.velocitiesKmS[3]).toBe(0);
    expect(state.velocitiesKmS[4]).toBeCloseTo(Math.sqrt(10.1), 14);
    expect(state.velocitiesKmS[5]).toBe(0);
    expect(state.velocitiesKmS[6]).toBe(0);
    expect(state.velocitiesKmS[7]).toBeCloseTo(Math.sqrt(10.1) + Math.sqrt(1.1), 14);
    expect(state.velocitiesKmS[8]).toBe(0);
  });

  it.each([86_400, -86_400])('advances elliptic mean anomaly at signed time %s', (timeSec) => {
    const bodies = nestedBodies().slice(0, 2);
    const catalog = compileRailsCatalog(bodies);
    const state = evaluateRailsInto(
      createRailsState(catalog),
      catalog,
      timeSec,
      createRailsWorkspace(),
    );
    const expectedElements = {
      ...(bodies[1]?.elements as OrbitalElements),
      meanAnomalyRad:
        (bodies[1]?.elements as OrbitalElements).meanAnomalyRad +
        (catalog.meanMotionRadS[1] as number) * timeSec,
    };
    const expected = elementsToStateInto(
      createCartesianState(),
      expectedElements,
      1_010,
      createOrbitalConversionScratch(),
    );

    expect(state.positionsKm[3]).toBeCloseTo(expected.positionKm.x, 10);
    expect(state.positionsKm[4]).toBeCloseTo(expected.positionKm.y, 10);
    expect(state.positionsKm[5]).toBeCloseTo(expected.positionKm.z, 10);
    expect(state.velocitiesKmS[3]).toBeCloseTo(expected.velocityKmS.x, 12);
    expect(state.velocitiesKmS[4]).toBeCloseTo(expected.velocityKmS.y, 12);
    expect(state.velocitiesKmS[5]).toBeCloseTo(expected.velocityKmS.z, 12);
  });

  it('advances a hyperbolic rail with its signed semimajor axis branch', () => {
    const bodies: RailsBodyInput[] = [
      { id: 'sun', parentId: null, muKm3S2: 1_000, elements: null },
      { id: 'comet', parentId: 'sun', muKm3S2: 0.1, elements: orbit(-100, 1.5) },
    ];
    const catalog = compileRailsCatalog(bodies);
    const timeSec = -100;
    const state = evaluateRailsInto(
      createRailsState(catalog),
      catalog,
      timeSec,
      createRailsWorkspace(),
    );
    const expectedElements = {
      ...(bodies[1]?.elements as OrbitalElements),
      meanAnomalyRad:
        (bodies[1]?.elements as OrbitalElements).meanAnomalyRad +
        (catalog.meanMotionRadS[1] as number) * timeSec,
    };
    const expected = elementsToStateInto(
      createCartesianState(),
      expectedElements,
      1_000.1,
      createOrbitalConversionScratch(),
    );

    expect(state.positionsKm[3]).toBeCloseTo(expected.positionKm.x, 10);
    expect(state.positionsKm[4]).toBeCloseTo(expected.positionKm.y, 10);
    expect(state.velocitiesKmS[3]).toBeCloseTo(expected.velocityKmS.x, 12);
    expect(state.velocitiesKmS[4]).toBeCloseTo(expected.velocityKmS.y, 12);
  });

  it('returns a cached state for the same time and recomputes for a new time', () => {
    const catalog = compileRailsCatalog(circularNestedBodies());
    const state = createRailsState(catalog);
    const workspace = createRailsWorkspace();
    evaluateRailsInto(state, catalog, 0, workspace);
    state.positionsKm[0] = 123;

    evaluateRailsInto(state, catalog, 0, workspace);
    expect(state.positionsKm[0]).toBe(123);

    evaluateRailsInto(state, catalog, 1, workspace);
    expect(state.positionsKm[0]).toBe(0);
  });

  it('rejects non-finite time and mismatched output sizes before evaluation', () => {
    const catalog = compileRailsCatalog(circularNestedBodies());
    const workspace = createRailsWorkspace();
    expect(() =>
      evaluateRailsInto(createRailsState(catalog), catalog, Number.NaN, workspace),
    ).toThrow(/time must be finite/u);

    const wrongSize: RailsState = {
      timeSec: Number.NaN,
      positionsKm: new Float64Array(1),
      velocitiesKmS: new Float64Array(1),
    };
    expect(() => evaluateRailsInto(wrongSize, catalog, 0, workspace)).toThrow(
      /state arrays must contain 9 components/u,
    );
  });
});
