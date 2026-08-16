import { describe, expect, it } from 'vitest';

import {
  HUD_PRESETS,
  HUD_SURFACES,
  formatHudPreset,
  hudPresetShows,
  isHudPreset,
  nextHudPreset,
  type HudSurface,
} from './hudPresets.js';

describe('HUD preset ring - T0112', () => {
  it('cycles clean to pilot to engineer and wraps', () => {
    expect(nextHudPreset('clean')).toBe('pilot');
    expect(nextHudPreset('pilot')).toBe('engineer');
    expect(nextHudPreset('engineer')).toBe('clean');
    // One full lap returns to the start, so the key is a ring and not a ladder.
    let preset = HUD_PRESETS[0] as 'clean';
    for (let step = 0; step < HUD_PRESETS.length; step += 1) {
      preset = nextHudPreset(preset) as 'clean';
    }
    expect(preset).toBe('clean');
  });

  it('shows exactly the Clean surfaces the spec names, and nothing else', () => {
    const clean = HUD_SURFACES.filter((surface) => hudPresetShows('clean', surface));
    expect([...clean].sort()).toEqual(
      ['cruiseStatus', 'reticle', 'targetMarker', 'throttleStrip', 'warnings'].sort(),
    );
  });

  it('adds the flight instruments at Pilot without losing anything Clean had', () => {
    for (const surface of HUD_SURFACES) {
      if (hudPresetShows('clean', surface)) expect(hudPresetShows('pilot', surface)).toBe(true);
    }
    expect(hudPresetShows('pilot', 'navball')).toBe(true);
    expect(hudPresetShows('pilot', 'dualClock')).toBe(true);
    expect(hudPresetShows('pilot', 'radarAltitude')).toBe(true);
    expect(hudPresetShows('pilot', 'warpIndicator')).toBe(true);
    expect(hudPresetShows('pilot', 'orbitReadout')).toBe(false);
    expect(hudPresetShows('pilot', 'burnLog')).toBe(false);
  });

  /**
   * The acceptance criterion "Engineer = all v1 panels" is a property of the tier
   * ladder, not of a list somebody keeps in sync — so assert the property.
   */
  it('shows every surface at Engineer, including ones added later', () => {
    for (const surface of HUD_SURFACES) {
      expect(hudPresetShows('engineer', surface)).toBe(true);
    }
    expect(hudPresetShows('engineer', 'somethingT0149Adds' as HudSurface)).toBe(true);
  });

  /**
   * The safe default for an unranked surface. A surface a later task forgets to
   * rank becomes Engineer-only, which is recoverable; the other default would
   * quietly put a new mission-control panel back into Clean and undo this task.
   */
  it('hides an unranked surface below Engineer', () => {
    expect(hudPresetShows('clean', 'somethingT0149Adds' as HudSurface)).toBe(false);
    expect(hudPresetShows('pilot', 'somethingT0149Adds' as HudSurface)).toBe(false);
  });

  it('guards and labels preset strings for the settings document', () => {
    expect(isHudPreset('clean')).toBe(true);
    expect(isHudPreset('Engineer')).toBe(false);
    expect(isHudPreset(3)).toBe(false);
    expect(isHudPreset(null)).toBe(false);
    expect(formatHudPreset('engineer')).toBe('Engineer');
  });
});
