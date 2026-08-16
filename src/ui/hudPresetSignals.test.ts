import { effect } from '@preact/signals';
import { describe, expect, it } from 'vitest';

import { createHudPresetStore } from './hudPresetSignals.js';

describe('HUD preset store - T0112', () => {
  it('seeds from the persisted profile', () => {
    const store = createHudPresetStore('pilot', false);

    expect(store.signals.preset.value).toBe('pilot');
    expect(store.signals.bodyLabels.value).toBe(false);
    expect(store.display.presetLabel.value).toBe('Pilot');
    expect(store.display.bodyLabelsLabel.value).toBe('Labels off');
  });

  it('exposes one memoised leaf per surface', () => {
    const store = createHudPresetStore('clean', true);

    expect(store.shows('reticle')).toBe(store.shows('reticle'));
    expect(store.shows('reticle').value).toBe(true);
    expect(store.shows('orbitReadout').value).toBe(false);
  });

  /**
   * The reason the preset is a signal graph rather than component state: cycling
   * must wake only the surfaces whose visibility actually changed.
   */
  it('notifies only the surfaces whose visibility changed', () => {
    const store = createHudPresetStore('clean', true);
    const reticleSeen: boolean[] = [];
    const navballSeen: boolean[] = [];
    const stopReticle = effect(() => {
      reticleSeen.push(store.shows('reticle').value);
    });
    const stopNavball = effect(() => {
      navballSeen.push(store.shows('navball').value);
    });
    expect(reticleSeen).toEqual([true]);
    expect(navballSeen).toEqual([false]);

    expect(store.cyclePreset()).toBe('pilot');

    // The reticle is visible in both presets, so its leaf never fired again.
    expect(reticleSeen).toEqual([true]);
    expect(navballSeen).toEqual([false, true]);
    stopReticle();
    stopNavball();
  });

  it('cycles the ring and reports the value the caller must persist', () => {
    const store = createHudPresetStore('clean', true);

    expect(store.cyclePreset()).toBe('pilot');
    expect(store.cyclePreset()).toBe('engineer');
    expect(store.cyclePreset()).toBe('clean');
    expect(store.signals.preset.value).toBe('clean');
  });

  it('sets and toggles body labels', () => {
    const store = createHudPresetStore('clean', true);

    expect(store.toggleBodyLabels()).toBe(false);
    expect(store.display.bodyLabelsLabel.value).toBe('Labels off');
    store.setBodyLabels(true);
    expect(store.signals.bodyLabels.value).toBe(true);
  });

  it('accepts an external preset change, as a settings-panel edit produces', () => {
    const store = createHudPresetStore('clean', true);

    store.setPreset('engineer');

    expect(store.shows('burnLog').value).toBe(true);
    expect(store.display.presetLabel.value).toBe('Engineer');
  });

  it('rejects an unknown surface instead of silently hiding it', () => {
    const store = createHudPresetStore('clean', true);

    expect(() => store.shows('nonsense' as 'reticle')).toThrow(/unknown HUD surface/u);
  });
});
