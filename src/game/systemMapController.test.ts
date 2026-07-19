import { describe, expect, it, vi } from 'vitest';

import { SystemMapController } from './systemMapController.js';

function createController() {
  const onModeChange = vi.fn();
  const onFocusChange = vi.fn();
  const controller = new SystemMapController({
    bodyIds: ['sun', 'earth', 'mars'],
    initialFocusId: 'sun',
    onModeChange,
    onFocusChange,
  });
  return { controller, onFocusChange, onModeChange };
}

describe('SystemMapController', () => {
  it('opens, closes, and toggles between space and system-map mode', () => {
    const { controller } = createController();

    expect(controller.mode).toBe('space');
    expect(controller.open()).toBe(true);
    expect(controller.mode).toBe('system-map');
    expect(controller.close()).toBe(true);
    expect(controller.mode).toBe('space');
    expect(controller.toggle()).toBe('system-map');
    expect(controller.toggle()).toBe('space');
  });

  it('keeps open and close idempotent and only reports real mode changes', () => {
    const { controller, onModeChange } = createController();

    expect(controller.close()).toBe(false);
    expect(controller.open()).toBe(true);
    expect(controller.open()).toBe(false);
    expect(controller.close()).toBe(true);
    expect(controller.close()).toBe(false);
    expect(onModeChange.mock.calls).toEqual([['system-map'], ['space']]);
  });

  it('accepts only catalog focus ids and only reports real focus changes', () => {
    const { controller, onFocusChange } = createController();

    expect(controller.focusId).toBe('sun');
    expect(controller.focusBody('earth')).toBe(true);
    expect(controller.focusId).toBe('earth');
    expect(controller.focusBody('earth')).toBe(false);
    expect(controller.focusBody('mars')).toBe(true);
    expect(onFocusChange.mock.calls).toEqual([['earth'], ['mars']]);
  });

  it('fails closed and preserves focus when a requested id is invalid', () => {
    const { controller, onFocusChange } = createController();

    expect(controller.focusBody('unknown')).toBe(false);
    expect(controller.focusBody('')).toBe(false);
    expect(controller.focusId).toBe('sun');
    expect(onFocusChange).not.toHaveBeenCalled();
  });

  it('rejects invalid catalogs and initial focus during setup', () => {
    expect(() => new SystemMapController({ bodyIds: [], initialFocusId: 'sun' })).toThrowError(
      'System map body ids cannot be empty.',
    );
    expect(
      () => new SystemMapController({ bodyIds: ['sun', 'sun'], initialFocusId: 'sun' }),
    ).toThrowError('Duplicate system map body id "sun".');
    expect(
      () => new SystemMapController({ bodyIds: ['sun'], initialFocusId: 'earth' }),
    ).toThrowError('Unknown initial system map focus "earth".');
  });
});
