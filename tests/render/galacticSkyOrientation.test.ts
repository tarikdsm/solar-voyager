import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  J2000_MEAN_OBLIQUITY_DEG,
  eclipticToGalacticInto,
  galacticLatitudeRad,
  galacticLongitudeRad,
} from '../../src/core/galacticFrame.js';
import { STAR_STRIDE_FLOATS, parseStarCatalog } from '../../src/render/starCatalog.js';

const RADIANS_TO_DEGREES = 180 / Math.PI;
const ARCSECONDS_PER_DEGREE = 3_600;

/**
 * Catalog record indices of three unmistakable stars in `data/stars.bin`.
 *
 * `tools/bake_stars.py` emits one record per Yale (BSC5) entry that carries J2000
 * coordinates, in strictly increasing HR order, so the index of a given HR number
 * is fixed by the pinned source checksum. The `visualMagnitude` assertion below
 * is what makes a silent re-bake that shifts these indices fail loudly instead of
 * quietly testing the wrong star.
 *
 * Galactic coordinates are SIMBAD's (CDS, queried 2026-08-16) and are independent
 * of anything in `src/core/galacticFrame.ts`.
 */
const REFERENCE_STARS = [
  {
    name: 'alf CMa (Sirius, HR 2491)',
    catalogIndex: 2_484,
    visualMagnitude: -1.46,
    galacticLongitudeDeg: 227.23029126,
    galacticLatitudeDeg: -8.89028121,
  },
  {
    name: 'alf Car (Canopus, HR 2326)',
    catalogIndex: 2_320,
    visualMagnitude: -0.72,
    galacticLongitudeDeg: 261.21210208,
    galacticLatitudeDeg: -25.29220544,
  },
  {
    name: 'alf Lyr (Vega, HR 7001)',
    catalogIndex: 6_989,
    visualMagnitude: 0.03,
    galacticLongitudeDeg: 67.44820813,
    galacticLatitudeDeg: 19.23725227,
  },
] as const;

/**
 * Yale BSC5 quantises right ascension to 0.1 s (<= 1.5 arcsec) and declination to
 * 1 arcsec, so a correct rotation still lands up to ~2 arcsec from SIMBAD's
 * full-precision position. Any error in the galactic pole, node or handedness
 * moves a star by degrees, three orders of magnitude outside this budget.
 */
const CATALOG_TOLERANCE_ARCSECONDS = 2;

function readCatalog(): Float32Array {
  const file = readFileSync(new URL('../../data/stars.bin', import.meta.url));
  const buffer = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
  return parseStarCatalog(buffer).data;
}

describe('galactic sky orientation against the shipped star catalog', () => {
  const catalog = readCatalog();
  const galactic = new Float64Array(3);

  it.each(REFERENCE_STARS)(
    'places $name at its catalogued galactic position',
    ({ catalogIndex, visualMagnitude, galacticLongitudeDeg, galacticLatitudeDeg }) => {
      const offset = catalogIndex * STAR_STRIDE_FLOATS;
      expect(catalog[offset + 3]).toBeCloseTo(visualMagnitude, 5);

      const x = catalog[offset] as number;
      const y = catalog[offset + 1] as number;
      const z = catalog[offset + 2] as number;
      // The payload stores float32 direction components, so the record is unit
      // length only to ~1e-8; renormalise before taking latitude.
      const length = Math.hypot(x, y, z);
      eclipticToGalacticInto(galactic, x / length, y / length, z / length);
      const galacticX = galactic[0] as number;
      const galacticY = galactic[1] as number;
      const galacticZ = galactic[2] as number;

      const longitudeDeg = galacticLongitudeRad(galacticX, galacticY) * RADIANS_TO_DEGREES;
      const latitudeDeg = galacticLatitudeRad(galacticX, galacticY, galacticZ) * RADIANS_TO_DEGREES;

      let longitudeDelta = longitudeDeg - galacticLongitudeDeg;
      if (longitudeDelta > 180) longitudeDelta -= 360;
      if (longitudeDelta < -180) longitudeDelta += 360;
      const separationArcseconds =
        Math.hypot(
          longitudeDelta * Math.cos((latitudeDeg * Math.PI) / 180),
          latitudeDeg - galacticLatitudeDeg,
        ) * ARCSECONDS_PER_DEGREE;

      expect(separationArcseconds).toBeLessThan(CATALOG_TOLERANCE_ARCSECONDS);
    },
  );

  it('shares one obliquity with the catalog bake script', () => {
    const bakeScript = readFileSync(new URL('../../tools/bake_stars.py', import.meta.url), 'utf8');
    // A drift here would rotate the panorama against the stars by up to 23 deg.
    expect(bakeScript).toContain(`math.radians(${J2000_MEAN_OBLIQUITY_DEG})`);
  });
});
