import { describe, expect, it } from 'vitest';

import { RING_DEFINITIONS, loadRingCatalog, ringDefinitionFor } from './ringCatalog.js';

describe('ring catalog', () => {
  it('loads the four ringed giants in stable body-id order', () => {
    expect(RING_DEFINITIONS.map((definition) => definition.bodyId)).toEqual([
      'jupiter',
      'neptune',
      'saturn',
      'uranus',
    ]);
    expect(ringDefinitionFor('earth')).toBeNull();
  });

  it('pins published ring proportions and Neptune arcs', () => {
    expect(ringDefinitionFor('saturn')).toMatchObject({
      innerRadiusRatio: 66_900 / 60_268,
      outerRadiusRatio: 140_224 / 60_268,
    });
    expect(ringDefinitionFor('jupiter')).toMatchObject({
      innerRadiusRatio: 100_000 / 71_492,
      outerRadiusRatio: 270_000 / 71_492,
    });
    expect(ringDefinitionFor('uranus')).toMatchObject({
      innerRadiusRatio: 36_100 / 25_559,
      outerRadiusRatio: 106_200 / 25_559,
    });
    expect(ringDefinitionFor('neptune')?.arcs.map((arc) => arc.name)).toEqual([
      'Fraternite',
      'Egalite',
      'Liberte',
      'Courage',
    ]);
  });

  it('rejects malformed, duplicated, and out-of-bounds data with field paths', () => {
    expect(() => loadRingCatalog({ schemaVersion: 0, systems: [] })).toThrow(/schemaVersion/u);
    expect(() =>
      loadRingCatalog({
        schemaVersion: 1,
        systems: [validSystem('saturn'), validSystem('saturn')],
      }),
    ).toThrow(/duplicate.*saturn/iu);
    const invalid = validSystem('saturn');
    const firstBand = invalid.bands[0];
    if (firstBand === undefined) throw new Error('Test fixture is missing its band.');
    invalid.bands[0] = { ...firstBand, outerRadiusKm: 999_999 };
    expect(() => loadRingCatalog({ schemaVersion: 1, systems: [invalid] })).toThrow(
      /systems\[0\]\.bands\[0\].*annulus/iu,
    );
  });
});

function validSystem(bodyId: string) {
  return {
    bodyId,
    referenceRadiusKm: 60_000,
    innerRadiusKm: 66_000,
    outerRadiusKm: 140_000,
    exposure: 2,
    baseColor: '#ffffff',
    bands: [
      {
        name: 'main',
        innerRadiusKm: 70_000,
        outerRadiusKm: 130_000,
        opticalDepth: 0.5,
        color: '#ffffff',
      },
    ],
    arcs: [],
    particles: null,
    sources: ['https://example.test/rings'],
  };
}
