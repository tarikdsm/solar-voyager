import { effect } from '@preact/signals';
import { describe, expect, it } from 'vitest';

import { createSystemMapSignalStore } from './systemMapSignals.js';

describe('system map signal store', () => {
  it('publishes mode and focus changes at leaf signals without duplicate notifications', () => {
    const store = createSystemMapSignalStore(['sun', 'earth', 'mars'], 'sun');
    let modeRuns = 0;
    let focusRuns = 0;
    const disposeMode = effect(() => {
      void store.signals.mode.value;
      modeRuns += 1;
    });
    const disposeFocus = effect(() => {
      void store.signals.focusBodyId.value;
      focusRuns += 1;
    });

    expect(store.publishMode('system-map')).toBe(true);
    expect(store.publishMode('system-map')).toBe(false);
    expect(store.publishFocus('earth')).toBe(true);
    expect(store.publishFocus('earth')).toBe(false);

    expect(store.display.open.value).toBe(true);
    expect(store.display.focusBodyLabel.value).toBe('Earth');
    expect(modeRuns).toBe(2);
    expect(focusRuns).toBe(2);
    disposeMode();
    disposeFocus();
  });

  it('fails closed for unknown focus ids and validates setup state', () => {
    const store = createSystemMapSignalStore(['sun', 'earth'], 'sun');

    expect(store.publishFocus('unknown')).toBe(false);
    expect(store.signals.focusBodyId.value).toBe('sun');
    expect(() => createSystemMapSignalStore([], 'sun')).toThrow(/cannot be empty/u);
    expect(() => createSystemMapSignalStore(['sun'], 'earth')).toThrow(/initial focus/u);
  });
});
