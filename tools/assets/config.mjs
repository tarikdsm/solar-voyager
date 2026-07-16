export const GUIDE = 'MODELING-GUIDE.md';

export const CATEGORY_CONFIG = Object.freeze({
  asteroids: Object.freeze({ manifestCategory: 'asteroid', triangleLimit: 5_000 }),
  comets: Object.freeze({ manifestCategory: 'comet', triangleLimit: 5_000 }),
  dwarfs: Object.freeze({ manifestCategory: 'dwarf', triangleLimit: 15_000 }),
  moons: Object.freeze({ manifestCategory: 'moon', triangleLimit: 15_000 }),
  planets: Object.freeze({ manifestCategory: 'planet', triangleLimit: 50_000 }),
  rings: Object.freeze({ manifestCategory: 'rings', triangleLimit: 5_000, normalizedBody: false }),
  ship: Object.freeze({ manifestCategory: 'ship', triangleLimit: 30_000, normalizedBody: false }),
  sun: Object.freeze({ manifestCategory: 'sun', triangleLimit: 50_000 }),
});

export const NORMALIZED_RADIUS_TOLERANCE = 1e-4;
export const ORIGIN_TOLERANCE = 1e-4;
const MIB = 1024 * 1024;
export const HERO_IDS = new Set(['earth', 'mars', 'moon']);
const MAJOR_MOON_IDS = new Set(['moon', 'io', 'europa', 'ganymede', 'callisto', 'titan', 'triton']);

export function assetByteBudget(category, id) {
  if (HERO_IDS.has(id)) return 20 * MIB;
  if (category === 'planets' || category === 'sun') return 12 * MIB;
  if (category === 'moons') return (MAJOR_MOON_IDS.has(id) ? 6 : 4) * MIB;
  if (category === 'dwarfs') return 4 * MIB;
  if (category === 'asteroids' || category === 'comets') return MIB;
  if (category === 'ship') return 8 * MIB;
  if (category === 'rings') return 2 * MIB;
  return 0;
}

export function guideReference(section) {
  return `${GUIDE} §${String(section)}`;
}
