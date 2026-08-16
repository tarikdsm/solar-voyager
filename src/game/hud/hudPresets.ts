/**
 * HUD preset ring (plan §T0112, spec §7).
 *
 * v1 showed every instrument at once. v2 makes instrumentation opt-in through
 * three presets, and the state machine is deliberately a **monotone tier ladder**
 * rather than three independent surface sets:
 *
 * ```
 * clean ⊂ pilot ⊂ engineer
 * ```
 *
 * Each surface declares the lowest preset that shows it, and visibility is a rank
 * comparison. That makes "Engineer shows everything v1 had" true by construction
 * instead of by a list somebody must remember to extend, and it makes the failure
 * mode of a surface added by a later task *safe*: an unranked surface defaults to
 * the highest tier, so it can never leak into Clean.
 */

export const HUD_PRESETS = Object.freeze(['clean', 'pilot', 'engineer'] as const);

export type HudPreset = (typeof HUD_PRESETS)[number];

/**
 * Every gated HUD surface.
 *
 * Named per rendered region rather than per component, because a component may
 * host more than one region (the flight strip carries `throttleStrip` and
 * `warnings`) and the preset ladder is about what the player sees.
 */
export const HUD_SURFACES = Object.freeze([
  // Clean — the whole HUD when instrumentation is off.
  'reticle',
  'throttleStrip',
  'warnings',
  'cruiseStatus',
  'targetMarker',
  // Pilot — flight instruments.
  'navball',
  'dualClock',
  'radarAltitude',
  'warpIndicator',
  // Engineer — the v1 mission-control panels.
  'orbitReadout',
  'energyPanel',
  'stateVectors',
  'burnLog',
  'targetPanel',
  'cameraHelp',
] as const);

export type HudSurface = (typeof HUD_SURFACES)[number];

const PRESET_RANK: Readonly<Record<HudPreset, number>> = Object.freeze({
  clean: 0,
  pilot: 1,
  engineer: 2,
});

/**
 * Lowest preset that shows each surface.
 *
 * `Partial` on purpose: a surface with no entry ranks at the top tier. A later
 * task that adds a surface and forgets this table gets an Engineer-only surface,
 * which is the recoverable mistake; the other default would quietly put a new
 * mission-control panel back into Clean and undo the point of the task.
 */
const SURFACE_MINIMUM_PRESET: Readonly<Partial<Record<HudSurface, HudPreset>>> = Object.freeze({
  reticle: 'clean',
  throttleStrip: 'clean',
  warnings: 'clean',
  cruiseStatus: 'clean',
  targetMarker: 'clean',
  navball: 'pilot',
  dualClock: 'pilot',
  radarAltitude: 'pilot',
  warpIndicator: 'pilot',
  orbitReadout: 'engineer',
  energyPanel: 'engineer',
  stateVectors: 'engineer',
  burnLog: 'engineer',
  targetPanel: 'engineer',
  cameraHelp: 'engineer',
});

const HIGHEST_RANK = HUD_PRESETS.length - 1;

/** True for a string that names a preset; the parse guard settings and tests share. */
export function isHudPreset(value: unknown): value is HudPreset {
  return typeof value === 'string' && HUD_PRESETS.includes(value as HudPreset);
}

/** Ring step used by the cycle key; wraps clean → pilot → engineer → clean. */
export function nextHudPreset(preset: HudPreset): HudPreset {
  const index = HUD_PRESETS.indexOf(preset);
  const next = HUD_PRESETS[(index + 1) % HUD_PRESETS.length];
  if (next === undefined) throw new Error('HUD preset ring is empty.');
  return next;
}

/** Whether `preset` shows `surface`. Allocation-free; safe to call per render. */
export function hudPresetShows(preset: HudPreset, surface: HudSurface): boolean {
  const minimum = SURFACE_MINIMUM_PRESET[surface];
  const required = minimum === undefined ? HIGHEST_RANK : PRESET_RANK[minimum];
  return PRESET_RANK[preset] >= required;
}

/** Short label for the preset indicator and the settings control. */
export function formatHudPreset(preset: HudPreset): string {
  return `${preset.charAt(0).toUpperCase()}${preset.slice(1)}`;
}
