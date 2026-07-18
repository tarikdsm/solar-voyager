import { describe, expect, it, vi } from 'vitest';

import { observeStateVectorLayout } from './stateVectorLayoutObserver.js';

class FakeResizeObserver {
  static instance: FakeResizeObserver | null = null;
  readonly observe = vi.fn();
  readonly disconnect = vi.fn();
  readonly callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    FakeResizeObserver.instance = this;
  }
}

describe('state-vector layout observer', () => {
  it('refreshes when any direct HUD panel changes size and disconnects cleanly', () => {
    const refresh = vi.fn();
    const panels = [{ id: 'perf-panel' }, { id: 'state-vector-panel' }] as unknown as Element[];
    const overlay = { children: panels } as unknown as HTMLElement;

    const dispose = observeStateVectorLayout(
      overlay,
      refresh,
      FakeResizeObserver as unknown as typeof ResizeObserver,
    );
    const observer = FakeResizeObserver.instance;

    expect(observer).not.toBeNull();
    expect(observer?.observe.mock.calls).toEqual([[panels[0]], [panels[1]]]);
    observer?.callback([], observer as unknown as ResizeObserver);
    expect(refresh).toHaveBeenCalledOnce();

    dispose();
    expect(observer?.disconnect).toHaveBeenCalledOnce();
  });
});
