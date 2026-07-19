import { signal } from '@preact/signals';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { DualClock, SpaceHudSurfaces } from './App.js';
import { createHudSignalStore } from './hudSignals.js';

describe('App system-map visibility', () => {
  it('hides the non-map HUD from sighted and assistive users through one leaf signal', () => {
    const mapOpen = signal(false);
    const view = SpaceHudSurfaces({
      mapOpen,
      children: <section id="regular-hud">Regular HUD</section>,
    });

    expect(view.props.class).toBe('space-hud-surfaces');
    expect(view.props.hidden).toBe(mapOpen);
    expect(view.props['aria-hidden']).toBe(mapOpen);
    expect(view.props.children.props.id).toBe('regular-hud');
  });

  it('keeps map controls scrollable in compact layouts and removes motion on request', () => {
    const css = readFileSync(new URL('./app.css', import.meta.url), 'utf8');

    expect(css).toMatch(/\.system-map-panel\s*\{[^}]*max-height:[^;}]+;[^}]*overflow-y:\s*auto;/su);
    expect(css).toMatch(
      /@media \(width <= 1100px\), \(height <= 44rem\)[\s\S]*\.system-map-panel/su,
    );
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.system-map-panel[\s\S]*transition:\s*none !important;/su,
    );
  });
});

describe('App mission clock', () => {
  it('labels the coordinate clock as mission UTC derived from TDB display time', () => {
    const clock = DualClock({ hud: createHudSignalStore().display });
    const serialized = JSON.stringify(clock);

    expect(serialized).toContain('Mission UTC · TDB display mapping');
    expect(serialized).toContain('Ship MET · proper time τ');
  });
});
