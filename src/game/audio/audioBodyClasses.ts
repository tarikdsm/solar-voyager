import bodiesDocument from '../../../data/bodies.json';

import type { AudioBodyClass } from './audioDirector.js';

/**
 * Setup-time catalog projection: how each body sounds, indexed like
 * `SimSnapshot.bodyIds`.
 *
 * Built once and injected into `AudioDirector`, which therefore never imports
 * the catalog and stays a pure function of the array it is handed. Same shape and
 * same reasoning as `game/hud/bodyMarkerCatalog.ts`: these are static catalog
 * facts, so publishing them through the snapshot would be waste.
 *
 * The mapping is about presence, not taxonomy. `surface.kind === 'gas'` is what
 * marks the four giants in `data/bodies.json`, so it is what the giant-approach
 * cue keys off rather than a hardcoded id list. Dwarf planets sit with the
 * terrestrials because Pluto and Ceres are worlds you go into orbit around, not
 * rocks you pass.
 */
export function createAudioBodyClasses(): readonly AudioBodyClass[] {
  const classes: AudioBodyClass[] = [];
  for (let index = 0; index < bodiesDocument.bodies.length; index += 1) {
    const body = bodiesDocument.bodies[index];
    if (body === undefined) throw new Error('Body catalog array is sparse.');
    classes.push(classifyBody(body.kind, body.surface.kind));
  }
  return Object.freeze(classes);
}

function classifyBody(kind: string, surfaceKind: string): AudioBodyClass {
  if (surfaceKind === 'stellar' || kind === 'star') return 'star';
  if (surfaceKind === 'gas') return 'giant';
  if (kind === 'planet' || kind === 'dwarf') return 'terrestrial';
  if (kind === 'moon') return 'moon';
  return 'small';
}
