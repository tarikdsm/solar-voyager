import bodiesDocument from '../../../data/bodies.json';

/**
 * Setup-time catalog projections the HUD needs and `SimSnapshot` does not carry.
 *
 * Mean radii (for angular-disc picking) and display names (for body labels) are
 * static catalog facts, so publishing them through the snapshot every 10 Hz would
 * be waste. Both arrays are built once, in `data/bodies.json` order — which is
 * `snapshot.bodyIds` order, since every consumer compiles the same document.
 */

/** Mean radii in km, indexed like `SimSnapshot.bodyIds`. */
export function createBodyRadiiKm(): Float64Array {
  const radiiKm = new Float64Array(bodiesDocument.bodies.length);
  for (let index = 0; index < bodiesDocument.bodies.length; index += 1) {
    const body = bodiesDocument.bodies[index];
    if (body === undefined) throw new Error('Body catalog array is sparse.');
    radiiKm[index] = body.meanRadiusKm;
  }
  return radiiKm;
}

/**
 * Display names, indexed like `SimSnapshot.bodyIds`.
 *
 * The catalog's own `name` rather than `formatBodyId(id)`, because the catalog
 * spells `1P` and `67P` the way an astronomer would and the id-title-caser
 * cannot.
 */
export function createBodyDisplayNames(): readonly string[] {
  const names: string[] = [];
  for (let index = 0; index < bodiesDocument.bodies.length; index += 1) {
    const body = bodiesDocument.bodies[index];
    if (body === undefined) throw new Error('Body catalog array is sparse.');
    names.push(body.name);
  }
  return Object.freeze(names);
}
