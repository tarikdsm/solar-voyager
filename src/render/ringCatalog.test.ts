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
      innerRadiusRatio: 37_850 / 25_559,
      outerRadiusRatio: 106_200 / 25_559,
    });
    expect(ringDefinitionFor('neptune')).toMatchObject({
      innerRadiusRatio: 41_000 / 24_764,
      outerRadiusRatio: 62_940.5 / 24_764,
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
    const uranus = ringDefinitionFor('uranus');
    expect(uranus?.bands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Zeta', innerRadiusKm: 37_850, outerRadiusKm: 41_350 }),
        expect.objectContaining({
          name: '6',
          innerRadiusKm: 41_837.235,
          outerRadiusKm: 41_838.765,
        }),
        expect.objectContaining({ name: '5', innerRadiusKm: 42_232.86, outerRadiusKm: 42_235.14 }),
        expect.objectContaining({
          name: '4',
          innerRadiusKm: 42_569.835,
          outerRadiusKm: 42_572.165,
        }),
        expect.objectContaining({
          name: 'Alpha',
          innerRadiusKm: 44_713.77,
          outerRadiusKm: 44_722.23,
        }),
        expect.objectContaining({
          name: 'Beta',
          innerRadiusKm: 45_656.255,
          outerRadiusKm: 45_665.745,
        }),
        expect.objectContaining({ name: 'Eta', innerRadiusKm: 47_175.2, outerRadiusKm: 47_176.8 }),
        expect.objectContaining({
          name: 'Gamma',
          innerRadiusKm: 47_625.925,
          outerRadiusKm: 47_628.075,
        }),
        expect.objectContaining({
          name: 'Delta',
          innerRadiusKm: 48_297.7,
          outerRadiusKm: 48_302.3,
        }),
        expect.objectContaining({
          name: 'Lambda',
          innerRadiusKm: 50_022.85,
          outerRadiusKm: 50_025.15,
        }),
        expect.objectContaining({
          name: 'Epsilon',
          innerRadiusKm: 51_119.95,
          outerRadiusKm: 51_178.05,
        }),
      ]),
    );
    const neptune = ringDefinitionFor('neptune');
    expect(neptune?.bands.find((band) => band.name === 'Lassell')).toMatchObject({
      innerRadiusKm: 53_200,
      outerRadiusKm: 57_200,
    });
    expect(neptune?.bands.find((band) => band.name === 'Adams')).toMatchObject({
      innerRadiusKm: 62_925.5,
      outerRadiusKm: 62_940.5,
    });
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
