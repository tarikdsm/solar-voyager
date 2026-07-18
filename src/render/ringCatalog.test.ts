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
      outerRadiusRatio: 140_612 / 60_268,
    });
    expect(ringDefinitionFor('jupiter')).toMatchObject({
      innerRadiusRatio: 100_000 / 71_492,
      outerRadiusRatio: 270_000 / 71_492,
    });
    expect(ringDefinitionFor('uranus')).toMatchObject({
      innerRadiusRatio: 36_100 / 25_559,
      outerRadiusRatio: 106_200 / 25_559,
    });
    const jupiter = ringDefinitionFor('jupiter');
    expect(jupiter?.bands.find((band) => band.name === 'Amalthea')).toMatchObject({
      innerRadiusKm: 122_400,
      outerRadiusKm: 181_350,
    });
    expect(jupiter?.bands.find((band) => band.name === 'Thebe')).toMatchObject({
      innerRadiusKm: 122_400,
      outerRadiusKm: 221_900,
    });
    const saturn = ringDefinitionFor('saturn');
    expect(saturn?.bands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'D', innerRadiusKm: 66_900, outerRadiusKm: 74_491 }),
        expect.objectContaining({ name: 'C', innerRadiusKm: 74_491, outerRadiusKm: 91_975 }),
        expect.objectContaining({ name: 'B', innerRadiusKm: 91_975, outerRadiusKm: 117_570 }),
        expect.objectContaining({ name: 'A', innerRadiusKm: 122_050, outerRadiusKm: 136_770 }),
        expect.objectContaining({ name: 'F', innerRadiusKm: 139_826, outerRadiusKm: 140_612 }),
      ]),
    );
    const neptune = ringDefinitionFor('neptune');
    expect(neptune?.arcs.map((arc) => arc.name)).toEqual([
      'Fraternite',
      'Egalite',
      'Liberte',
      'Courage',
    ]);
    expect(neptune?.arcs.every((arc) => arc.bandName === 'Adams')).toBe(true);
    expect(ringDefinitionFor('saturn')?.sources).toContain(
      'https://pds-rings.seti.org/saturn/saturn_rings_table.html',
    );
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
    const invalidArcBand = validSystem('neptune');
    invalidArcBand.arcs = [
      { name: 'Test arc', bandName: 'missing', centerDeg: 0, widthDeg: 2, gain: 2 },
    ];
    expect(() => loadRingCatalog({ schemaVersion: 1, systems: [invalidArcBand] })).toThrow(
      /arcs\[0\].*bandName.*missing/iu,
    );
  });
});

function validSystem(bodyId: string, arcs: unknown[] = []) {
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
    arcs,
    particles: null,
    sources: ['https://example.test/rings'],
  };
}
