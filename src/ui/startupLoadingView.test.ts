import { describe, expect, it } from 'vitest';

import { StartupTracker } from '../game/startupTracker.js';
import { updateStartupLoadingView, type StartupLoadingElements } from './startupLoadingView.js';

function elements(): StartupLoadingElements {
  const attributes = new Map<string, string>();
  return {
    message: { textContent: '' } as HTMLElement,
    progress: { value: 0 } as HTMLProgressElement,
    retry: { hidden: true } as HTMLButtonElement,
    root: {
      dataset: {},
      hidden: false,
      setAttribute: (name: string, value: string) => attributes.set(name, value),
      getAttribute: (name: string) => attributes.get(name) ?? null,
    } as unknown as HTMLElement,
  };
}

describe('startup loading view', () => {
  it('mirrors truthful progress and next-work text without hiding early', () => {
    const tracker = new StartupTracker(0);
    const view = elements();
    tracker.advance('context');
    updateStartupLoadingView(view, tracker);

    expect(view.root.dataset.startupStage).toBe('context');
    expect(view.root.getAttribute('aria-busy')).toBe('true');
    expect(view.progress.value).toBe(0.1);
    expect(view.message.textContent).toBe('Loading star catalog');
    expect(view.retry.hidden).toBe(true);
    expect(view.root.hidden).toBe(false);
  });

  it('announces failure, preserves progress, and exposes Retry', () => {
    const tracker = new StartupTracker(0);
    const view = elements();
    tracker.advance('context');
    tracker.fail(new Error('network denied'));
    updateStartupLoadingView(view, tracker);

    expect(view.root.getAttribute('role')).toBe('alert');
    expect(view.root.getAttribute('aria-busy')).toBe('false');
    expect(view.progress.value).toBe(0.1);
    expect(view.message.textContent).toContain('network denied');
    expect(view.retry.hidden).toBe(false);
    expect(view.root.hidden).toBe(false);
  });

  it('hides only at the recorded first-playable milestone', () => {
    const tracker = new StartupTracker(0);
    const view = elements();
    for (const stage of [
      'context',
      'star-catalog',
      'asset-manifest',
      'hero-spheres',
      'flight-shaders',
      'map-shaders',
    ] as const) {
      tracker.advance(stage);
    }
    tracker.recordQuality(0, 'manual', null);
    tracker.advance('post-ready');
    tracker.recordReady(1, {
      encodedBodyBytes: 0,
      programCount: 1,
      resourceCount: 0,
      transferBytes: 0,
    });
    updateStartupLoadingView(view, tracker);

    expect(view.root.dataset.startupStage).toBe('ready');
    expect(view.root.getAttribute('aria-busy')).toBe('false');
    expect(view.progress.value).toBe(1);
    expect(view.root.hidden).toBe(true);
  });
});
