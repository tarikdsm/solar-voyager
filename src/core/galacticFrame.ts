// physics-spec.md §1.1 — galactic frame and its rotation from ecliptic J2000.

/**
 * IAU 1958 galactic pole and node, expressed in the J2000 equatorial frame.
 *
 * These three numbers *define* the galactic frame; every other quantity in this
 * module is derived from them so that a single edit here moves the whole frame
 * coherently. Values are the standard J2000 realisation of the IAU 1958 system
 * (Blaauw et al. 1960 as precessed in the Hipparcos/Tycho catalogues, ESA
 * SP-1200 vol. 1 section 1.5.3).
 */
export const NORTH_GALACTIC_POLE_RIGHT_ASCENSION_DEG = 192.85948;
/** Declination of the north galactic pole in the J2000 equatorial frame. */
export const NORTH_GALACTIC_POLE_DECLINATION_DEG = 27.12825;
/** Galactic longitude of the J2000 north celestial pole. */
export const NORTH_CELESTIAL_POLE_GALACTIC_LONGITUDE_DEG = 122.93192;

/**
 * Mean obliquity of the ecliptic at J2000.
 *
 * Must stay bit-identical to `J2000_OBLIQUITY_RAD` in `tools/bake_stars.py`:
 * the baked star catalog is rotated into the ecliptic frame with that value, so
 * any disagreement would shear the panorama against the stars.
 */
export const J2000_MEAN_OBLIQUITY_DEG = 23.439291111;

const DEGREES_TO_RADIANS = Math.PI / 180;

const NORTH_GALACTIC_POLE_RIGHT_ASCENSION_RAD =
  NORTH_GALACTIC_POLE_RIGHT_ASCENSION_DEG * DEGREES_TO_RADIANS;
const NORTH_GALACTIC_POLE_DECLINATION_RAD =
  NORTH_GALACTIC_POLE_DECLINATION_DEG * DEGREES_TO_RADIANS;
const NORTH_CELESTIAL_POLE_GALACTIC_LONGITUDE_RAD =
  NORTH_CELESTIAL_POLE_GALACTIC_LONGITUDE_DEG * DEGREES_TO_RADIANS;

/** Mean obliquity of the ecliptic at J2000, in radians. */
export const J2000_MEAN_OBLIQUITY_RAD = J2000_MEAN_OBLIQUITY_DEG * DEGREES_TO_RADIANS;

/** Rotates `vector` about the unit axis `axis` by `angleRad` (right-handed). */
function rotateAboutAxis(
  vector: readonly [number, number, number],
  axis: readonly [number, number, number],
  angleRad: number,
): [number, number, number] {
  const cosine = Math.cos(angleRad);
  const sine = Math.sin(angleRad);
  const axisDotVector = axis[0] * vector[0] + axis[1] * vector[1] + axis[2] * vector[2];
  const crossX = axis[1] * vector[2] - axis[2] * vector[1];
  const crossY = axis[2] * vector[0] - axis[0] * vector[2];
  const crossZ = axis[0] * vector[1] - axis[1] * vector[0];
  const parallel = axisDotVector * (1 - cosine);
  return [
    vector[0] * cosine + crossX * sine + axis[0] * parallel,
    vector[1] * cosine + crossY * sine + axis[1] * parallel,
    vector[2] * cosine + crossZ * sine + axis[2] * parallel,
  ];
}

/**
 * Builds the row-major ecliptic-J2000 to galactic rotation from the three
 * defining constants, without relying on an Euler-angle convention.
 *
 * The galactic basis is assembled in equatorial coordinates first:
 * `zGalactic` points at the north galactic pole; the ascending node of the
 * galactic equator on the celestial equator is `zEquatorial x zGalactic`, which
 * sits at galactic longitude `lNorthCelestialPole - 90 deg`; rotating that node
 * backwards about `zGalactic` by the same amount lands on galactic longitude
 * zero, which is `xGalactic`. The equatorial-to-ecliptic obliquity rotation is
 * then folded in on the right.
 */
function buildEclipticToGalacticRowMajor(): number[] {
  const cosineDeclination = Math.cos(NORTH_GALACTIC_POLE_DECLINATION_RAD);
  const zGalactic: [number, number, number] = [
    cosineDeclination * Math.cos(NORTH_GALACTIC_POLE_RIGHT_ASCENSION_RAD),
    cosineDeclination * Math.sin(NORTH_GALACTIC_POLE_RIGHT_ASCENSION_RAD),
    Math.sin(NORTH_GALACTIC_POLE_DECLINATION_RAD),
  ];
  const ascendingNode: [number, number, number] = [
    -Math.sin(NORTH_GALACTIC_POLE_RIGHT_ASCENSION_RAD),
    Math.cos(NORTH_GALACTIC_POLE_RIGHT_ASCENSION_RAD),
    0,
  ];
  const ascendingNodeLongitudeRad = NORTH_CELESTIAL_POLE_GALACTIC_LONGITUDE_RAD - Math.PI / 2;
  const xGalactic = rotateAboutAxis(ascendingNode, zGalactic, -ascendingNodeLongitudeRad);
  const yGalactic: [number, number, number] = [
    zGalactic[1] * xGalactic[2] - zGalactic[2] * xGalactic[1],
    zGalactic[2] * xGalactic[0] - zGalactic[0] * xGalactic[2],
    zGalactic[0] * xGalactic[1] - zGalactic[1] * xGalactic[0],
  ];

  // Equatorial from ecliptic is a rotation by -obliquity about +X, the exact
  // inverse of the ecliptic rotation `tools/bake_stars.py` applies to the catalog.
  const cosineObliquity = Math.cos(J2000_MEAN_OBLIQUITY_RAD);
  const sineObliquity = Math.sin(J2000_MEAN_OBLIQUITY_RAD);
  const rows: [number, number, number][] = [xGalactic, yGalactic, zGalactic];
  const rowMajor: number[] = [];
  for (const row of rows) {
    rowMajor.push(
      row[0],
      row[1] * cosineObliquity + row[2] * sineObliquity,
      -row[1] * sineObliquity + row[2] * cosineObliquity,
    );
  }
  return rowMajor;
}

/**
 * Row-major 3x3 rotation taking heliocentric ecliptic-J2000 unit directions to
 * the galactic frame (+X toward the galactic centre, +Z toward the north
 * galactic pole). physics-spec.md §1.1.
 */
export const ECLIPTIC_J2000_TO_GALACTIC_ROW_MAJOR: readonly number[] = Object.freeze(
  buildEclipticToGalacticRowMajor(),
);

/** Rotates one ecliptic-J2000 direction into the galactic frame, in place. */
export function eclipticToGalacticInto(
  out: Float64Array,
  x: number,
  y: number,
  z: number,
  outOffset = 0,
): void {
  const matrix = ECLIPTIC_J2000_TO_GALACTIC_ROW_MAJOR;
  out[outOffset] =
    (matrix[0] as number) * x + (matrix[1] as number) * y + (matrix[2] as number) * z;
  out[outOffset + 1] =
    (matrix[3] as number) * x + (matrix[4] as number) * y + (matrix[5] as number) * z;
  out[outOffset + 2] =
    (matrix[6] as number) * x + (matrix[7] as number) * y + (matrix[8] as number) * z;
}

/** Galactic longitude of a galactic-frame direction, wrapped to [0, 2*pi). */
export function galacticLongitudeRad(x: number, y: number): number {
  const longitude = Math.atan2(y, x);
  return longitude < 0 ? longitude + 2 * Math.PI : longitude;
}

/** Galactic latitude of a galactic-frame unit direction, in [-pi/2, pi/2]. */
export function galacticLatitudeRad(x: number, y: number, z: number): number {
  return Math.atan2(z, Math.hypot(x, y));
}
