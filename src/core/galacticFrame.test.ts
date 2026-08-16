import { describe, expect, it } from 'vitest';

import {
  ECLIPTIC_J2000_TO_GALACTIC_ROW_MAJOR,
  J2000_MEAN_OBLIQUITY_RAD,
  NORTH_CELESTIAL_POLE_GALACTIC_LONGITUDE_DEG,
  NORTH_GALACTIC_POLE_DECLINATION_DEG,
  NORTH_GALACTIC_POLE_RIGHT_ASCENSION_DEG,
  eclipticToGalacticInto,
  galacticLatitudeRad,
  galacticLongitudeRad,
} from './galacticFrame.js';

const DEGREES_TO_RADIANS = Math.PI / 180;
const RADIANS_TO_DEGREES = 180 / Math.PI;
const ARCSECONDS_PER_DEGREE = 3_600;

/**
 * SIMBAD (CDS, queried 2026-08-16) J2000 ICRS positions and the galactic
 * coordinates SIMBAD derives from them. These are the independent ground truth
 * the rotation is checked against — nothing in `galacticFrame.ts` was derived
 * from them.
 */
const BRIGHT_STARS = [
  {
    name: 'alf CMa (Sirius)',
    rightAscensionHms: [6, 45, 8.91728] as const,
    declinationDms: [-1, 16, 42, 58.0171] as const,
    galacticLongitudeDeg: 227.23029126,
    galacticLatitudeDeg: -8.89028121,
  },
  {
    name: 'alf Car (Canopus)',
    rightAscensionHms: [6, 23, 57.10988] as const,
    declinationDms: [-1, 52, 41, 44.381] as const,
    galacticLongitudeDeg: 261.21210208,
    galacticLatitudeDeg: -25.29220544,
  },
  {
    name: 'alf Lyr (Vega)',
    rightAscensionHms: [18, 36, 56.33635] as const,
    declinationDms: [1, 38, 47, 1.2802] as const,
    galacticLongitudeDeg: 67.44820813,
    galacticLatitudeDeg: 19.23725227,
  },
] as const;

function equatorialToEclipticDirection(
  rightAscensionHms: readonly [number, number, number],
  declinationDms: readonly [number, number, number, number],
): [number, number, number] {
  const rightAscensionRad =
    (rightAscensionHms[0] + rightAscensionHms[1] / 60 + rightAscensionHms[2] / 3_600) *
    15 *
    DEGREES_TO_RADIANS;
  const declinationRad =
    declinationDms[0] *
    (declinationDms[1] + declinationDms[2] / 60 + declinationDms[3] / 3_600) *
    DEGREES_TO_RADIANS;
  const cosineDeclination = Math.cos(declinationRad);
  const equatorial = [
    cosineDeclination * Math.cos(rightAscensionRad),
    cosineDeclination * Math.sin(rightAscensionRad),
    Math.sin(declinationRad),
  ] as const;
  const cosineObliquity = Math.cos(J2000_MEAN_OBLIQUITY_RAD);
  const sineObliquity = Math.sin(J2000_MEAN_OBLIQUITY_RAD);
  return [
    equatorial[0],
    cosineObliquity * equatorial[1] + sineObliquity * equatorial[2],
    -sineObliquity * equatorial[1] + cosineObliquity * equatorial[2],
  ];
}

function galacticDegreesOf(direction: readonly [number, number, number]): {
  longitudeDeg: number;
  latitudeDeg: number;
} {
  const galactic = new Float64Array(3);
  eclipticToGalacticInto(galactic, direction[0], direction[1], direction[2]);
  const x = galactic[0] as number;
  const y = galactic[1] as number;
  const z = galactic[2] as number;
  return {
    longitudeDeg: galacticLongitudeRad(x, y) * RADIANS_TO_DEGREES,
    latitudeDeg: galacticLatitudeRad(x, y, z) * RADIANS_TO_DEGREES,
  };
}

function angularSeparationArcseconds(
  longitudeDeg: number,
  latitudeDeg: number,
  referenceLongitudeDeg: number,
  referenceLatitudeDeg: number,
): number {
  let longitudeDelta = longitudeDeg - referenceLongitudeDeg;
  if (longitudeDelta > 180) longitudeDelta -= 360;
  if (longitudeDelta < -180) longitudeDelta += 360;
  const alongLongitude = longitudeDelta * Math.cos(latitudeDeg * DEGREES_TO_RADIANS);
  return Math.hypot(alongLongitude, latitudeDeg - referenceLatitudeDeg) * ARCSECONDS_PER_DEGREE;
}

describe('galacticFrame', () => {
  it('is a proper rotation', () => {
    const matrix = ECLIPTIC_J2000_TO_GALACTIC_ROW_MAJOR;
    expect(matrix).toHaveLength(9);
    for (let row = 0; row < 3; row += 1) {
      for (let other = 0; other < 3; other += 1) {
        let product = 0;
        for (let column = 0; column < 3; column += 1) {
          product += (matrix[row * 3 + column] as number) * (matrix[other * 3 + column] as number);
        }
        expect(product).toBeCloseTo(row === other ? 1 : 0, 14);
      }
    }
    const determinant =
      (matrix[0] as number) *
        ((matrix[4] as number) * (matrix[8] as number) -
          (matrix[5] as number) * (matrix[7] as number)) -
      (matrix[1] as number) *
        ((matrix[3] as number) * (matrix[8] as number) -
          (matrix[5] as number) * (matrix[6] as number)) +
      (matrix[2] as number) *
        ((matrix[3] as number) * (matrix[7] as number) -
          (matrix[4] as number) * (matrix[6] as number));
    expect(determinant).toBeCloseTo(1, 14);
  });

  it('sends the defining north galactic pole to galactic latitude +90 degrees', () => {
    const pole = equatorialToEclipticDirection(
      [NORTH_GALACTIC_POLE_RIGHT_ASCENSION_DEG / 15, 0, 0],
      [1, NORTH_GALACTIC_POLE_DECLINATION_DEG, 0, 0],
    );
    expect(galacticDegreesOf(pole).latitudeDeg).toBeCloseTo(90, 10);
  });

  it('places the north celestial pole at the defining galactic longitude', () => {
    const northCelestialPole = equatorialToEclipticDirection([0, 0, 0], [1, 90, 0, 0]);
    const { longitudeDeg, latitudeDeg } = galacticDegreesOf(northCelestialPole);
    expect(longitudeDeg).toBeCloseTo(NORTH_CELESTIAL_POLE_GALACTIC_LONGITUDE_DEG, 10);
    expect(latitudeDeg).toBeCloseTo(NORTH_GALACTIC_POLE_DECLINATION_DEG, 10);
  });

  it('reproduces the SIMBAD galactic coordinates of three bright stars', () => {
    // The SIMBAD galactic values are quoted to 1e-8 deg; agreement inside a
    // tenth of an arcsecond leaves no room for a wrong pole, node or handedness,
    // each of which would move a star by degrees.
    const toleranceArcseconds = 0.1;
    for (const star of BRIGHT_STARS) {
      const { longitudeDeg, latitudeDeg } = galacticDegreesOf(
        equatorialToEclipticDirection(star.rightAscensionHms, star.declinationDms),
      );
      const separationArcseconds = angularSeparationArcseconds(
        longitudeDeg,
        latitudeDeg,
        star.galacticLongitudeDeg,
        star.galacticLatitudeDeg,
      );
      expect(
        separationArcseconds,
        `${star.name} is ${separationArcseconds.toFixed(4)} arcsec from its catalogued position`,
      ).toBeLessThan(toleranceArcseconds);
    }
  });

  it('wraps galactic longitude into [0, 360) degrees', () => {
    expect(galacticLongitudeRad(1, 0)).toBeCloseTo(0, 15);
    expect(galacticLongitudeRad(0, 1) * RADIANS_TO_DEGREES).toBeCloseTo(90, 12);
    expect(galacticLongitudeRad(-1, 0) * RADIANS_TO_DEGREES).toBeCloseTo(180, 12);
    expect(galacticLongitudeRad(0, -1) * RADIANS_TO_DEGREES).toBeCloseTo(270, 12);
  });

  it('reports galactic latitude for non-unit directions', () => {
    expect(galacticLatitudeRad(0, 0, 5) * RADIANS_TO_DEGREES).toBeCloseTo(90, 12);
    expect(galacticLatitudeRad(3, 4, 0) * RADIANS_TO_DEGREES).toBeCloseTo(0, 12);
    expect(galacticLatitudeRad(0, 0, -0.5) * RADIANS_TO_DEGREES).toBeCloseTo(-90, 12);
  });
});
