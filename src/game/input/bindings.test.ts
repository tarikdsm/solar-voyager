import { describe, expect, it } from 'vitest';

import { DEFAULT_GAME_SETTINGS, rebindInput } from '../settings.js';
import {
  BindingTable,
  INPUT_ACTIONS,
  INPUT_ACTION_COUNT,
  actionIndex,
  blocksGameKey,
  isActivationKeyForTarget,
  isEditableTarget,
} from './bindings.js';

function target(shape: Record<string, unknown>): EventTarget {
  return shape as unknown as EventTarget;
}

describe('isEditableTarget', () => {
  it('blocks real text entry by tag name, selector match, and ancestry', () => {
    expect(isEditableTarget(target({ tagName: 'INPUT' }))).toBe(true);
    expect(isEditableTarget(target({ tagName: 'select' }))).toBe(true);
    expect(isEditableTarget(target({ tagName: 'TEXTAREA' }))).toBe(true);
    expect(isEditableTarget(target({ isContentEditable: true }))).toBe(true);
    expect(isEditableTarget(target({ matches: (s: string) => s.includes('input') }))).toBe(true);
    expect(
      isEditableTarget(
        target({
          closest: (s: string) => (s === 'input, select, textarea' ? {} : null),
        }),
      ),
    ).toBe(true);
  });

  it('blocks an inherited contenteditable owner via attribute or property', () => {
    const inheritedByAttribute = target({
      isContentEditable: false,
      matches: () => false,
      closest: (s: string) =>
        s === '[contenteditable]' ? { getAttribute: () => '', isContentEditable: false } : null,
    });
    const inheritedByProperty = target({
      matches: () => false,
      closest: (s: string) => (s === '[contenteditable]' ? { isContentEditable: true } : null),
    });
    const explicitlyDisabled = target({
      matches: () => false,
      closest: (s: string) =>
        s === '[contenteditable]'
          ? { getAttribute: () => 'false', isContentEditable: false }
          : null,
    });

    expect(isEditableTarget(inheritedByAttribute)).toBe(true);
    expect(isEditableTarget(inheritedByProperty)).toBe(true);
    expect(isEditableTarget(explicitlyDisabled)).toBe(false);
  });

  it('never blocks buttons, canvases, or a null target', () => {
    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget(target({ tagName: 'BUTTON', isContentEditable: false }))).toBe(false);
    expect(isEditableTarget(target({ tagName: 'CANVAS' }))).toBe(false);
    expect(isEditableTarget(target({ tagName: 'SUMMARY' }))).toBe(false);
    expect(isEditableTarget(target({ matches: (s: string) => s.includes('button') }))).toBe(false);
  });
});

describe('isActivationKeyForTarget', () => {
  it('recognizes the keys the browser uses to activate the focused control', () => {
    const button = target({ tagName: 'BUTTON' });
    expect(isActivationKeyForTarget('Space', button)).toBe(true);
    expect(isActivationKeyForTarget('Enter', button)).toBe(true);
    expect(isActivationKeyForTarget('NumpadEnter', button)).toBe(true);
    expect(isActivationKeyForTarget('Space', target({ tagName: 'SUMMARY' }))).toBe(true);
    expect(isActivationKeyForTarget('Enter', target({ tagName: 'a' }))).toBe(true);
    expect(isActivationKeyForTarget('Space', target({ getAttribute: () => 'button' }))).toBe(true);
  });

  it('leaves every other key and every non-activatable target to the game', () => {
    const button = target({ tagName: 'BUTTON' });
    expect(isActivationKeyForTarget('KeyW', button)).toBe(false);
    expect(isActivationKeyForTarget('Space', null)).toBe(false);
    expect(isActivationKeyForTarget('Space', target({ tagName: 'CANVAS' }))).toBe(false);
    expect(isActivationKeyForTarget('Space', target({ tagName: 'DIV' }))).toBe(false);
    expect(isActivationKeyForTarget('Space', target({ getAttribute: () => null }))).toBe(false);
  });
});

describe('blocksGameKey', () => {
  it('yields to a control that already consumed the key', () => {
    const button = target({ tagName: 'BUTTON' });
    expect(blocksGameKey({ code: 'KeyW', defaultPrevented: false, target: button })).toBe(false);
    expect(blocksGameKey({ code: 'KeyW', defaultPrevented: true, target: button })).toBe(true);
    expect(blocksGameKey({ target: button })).toBe(false);
    expect(blocksGameKey({ target: target({ tagName: 'INPUT' }) })).toBe(true);
  });

  it('yields the focused control its native activation keys', () => {
    const button = target({ tagName: 'BUTTON' });
    expect(blocksGameKey({ code: 'Space', target: button })).toBe(true);
    expect(blocksGameKey({ code: 'Enter', target: target({ tagName: 'SUMMARY' }) })).toBe(true);
    expect(blocksGameKey({ code: 'Space', target: null })).toBe(false);
    expect(blocksGameKey({ code: 'Space', target: target({ tagName: 'CANVAS' }) })).toBe(false);
  });
});

describe('actionIndex', () => {
  it('assigns every action a distinct dense index', () => {
    const seen = new Set<number>();
    for (const action of INPUT_ACTIONS) {
      const index = actionIndex(action);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(INPUT_ACTION_COUNT);
      seen.add(index);
    }
    expect(seen.size).toBe(INPUT_ACTION_COUNT);
  });
});

describe('BindingTable', () => {
  it('resolves default codes and reroutes after a rebind', () => {
    const table = new BindingTable(DEFAULT_GAME_SETTINGS.inputBindings);
    expect(table.resolve('KeyW')).toBe('pitchUp');
    expect(table.resolve('Digit3')).toBe('attitudeRetrograde');
    expect(table.resolve('KeyI')).toBeUndefined();

    table.rebuild(rebindInput(DEFAULT_GAME_SETTINGS, 'pitchUp', 'KeyI').inputBindings);
    expect(table.resolve('KeyI')).toBe('pitchUp');
    expect(table.resolve('KeyW')).toBeUndefined();
  });

  it('rejects a duplicate code and keeps the previous table', () => {
    const table = new BindingTable(DEFAULT_GAME_SETTINGS.inputBindings);
    const duplicated = { ...DEFAULT_GAME_SETTINGS.inputBindings, yawLeft: 'KeyW' };

    expect(() => table.rebuild(duplicated)).toThrow(RangeError);
    expect(table.resolve('KeyW')).toBe('pitchUp');
    expect(table.resolve('KeyA')).toBe('yawLeft');
  });
});
