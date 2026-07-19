import type { ComponentChildren, VNode } from 'preact';
import { describe, expect, it, vi } from 'vitest';

import { KeyboardCommandMapper, type KeyboardInputEvent } from '../game/inputMapping.js';
import { DEFAULT_GAME_SETTINGS, type InputBindings } from '../game/settings.js';
import type { Commands } from '../sim/simulationSnapshot.js';
import type { BurnLogEntry, BurnLogView } from '../sim/ship/ledger.js';
import { createBurnLogSignalStore } from './burnLogSignals.js';
import {
  BurnMetrics,
  BurnLogPanelView,
  createBurnLogPanelModel,
  type BurnLogPanelKeyboardEvent,
} from './BurnLogPanel.js';

type InspectedProps = Record<string, unknown> & { readonly children?: ComponentChildren };

function childNodes(children: ComponentChildren): VNode<InspectedProps>[] {
  const pending = Array.isArray(children) ? [...children] : [children];
  const nodes: VNode<InspectedProps>[] = [];
  while (pending.length > 0) {
    const value = pending.shift();
    if (Array.isArray(value)) pending.unshift(...value);
    else if (value !== null && typeof value === 'object' && 'type' in value) {
      const node = value as VNode<InspectedProps>;
      nodes.push(node);
      pending.unshift(
        ...(Array.isArray(node.props.children) ? node.props.children : [node.props.children]),
      );
    }
  }
  return nodes;
}

function entry(sequence: number): BurnLogEntry {
  return {
    startTimeSec: sequence * 10,
    endTimeSec: sequence * 10 + 4,
    startProperTimeSec: sequence * 8,
    endProperTimeSec: sequence * 8 + 3,
    energySpentJ: sequence * 3_600,
    properDeltaVMS: sequence + 0.25,
    peakPowerW: sequence * 1_000,
    dominantBodyId: sequence % 2 === 0 ? 'earth' : 'mars',
    progradeDeltaVMS: sequence + 1,
    normalDeltaVMS: -(sequence + 2),
    radialDeltaVMS: sequence + 3,
  };
}

class TestBurnLogView implements BurnLogView {
  readonly capacity = 256;
  readonly entries: BurnLogEntry[] = [];
  activeBurn: BurnLogEntry | null = null;

  get count(): number {
    return this.entries.length;
  }

  get(index: number): BurnLogEntry | null {
    return this.entries[index] ?? null;
  }
}

function keyboardEvent(code: string): BurnLogPanelKeyboardEvent {
  return {
    code,
    preventDefault: vi.fn(),
    target: { tagName: 'BUTTON' } as unknown as EventTarget,
  };
}

describe('BurnLogPanel', () => {
  it('mounts all bounded row identities while exposing distinct empty, active, and completed states', () => {
    const view = new TestBurnLogView();
    view.activeBurn = entry(30);
    view.entries.push(entry(11), entry(20));
    const store = createBurnLogSignalStore(view);
    const model = createBurnLogPanelModel(store);
    const panel = BurnLogPanelView({ store, model });
    const nodes = childNodes(panel.props.children);
    const toggle = nodes.find((node) => node.props.id === 'burn-log-toggle');
    const region = nodes.find((node) => node.props.id === 'burn-log-panel');
    const summary = nodes.find((node) => node.props.id === 'burn-log-summary');
    const empty = nodes.find((node) => node.props.id === 'burn-log-empty');
    const active = nodes.find((node) => node.props.id === 'burn-log-active');
    const completedRows = nodes.filter((node) => node.props['data-burn-slot'] !== undefined);
    const rowButtons = nodes.filter((node) => node.props['data-burn-row'] !== undefined);

    expect(toggle?.props['aria-expanded']).toBe(model.expanded);
    expect(toggle?.props['aria-controls']).toBe('burn-log-panel');
    expect(region?.props['aria-labelledby']).toBe('burn-log-title');
    expect(region?.props.hidden).toBe(model.collapsed);
    expect(summary?.props['aria-live']).toBe('polite');
    expect(empty?.props.hidden).toBe(model.emptyHidden);
    expect(active?.props.hidden).toBe(model.activeHidden);
    expect(JSON.stringify(BurnMetrics({ active: true, row: store.activeRow }))).toContain(
      'Current (mission UTC)',
    );
    expect(JSON.stringify(BurnMetrics({ active: true, row: store.activeRow }))).toContain(
      'Current (ship MET)',
    );
    expect(completedRows).toHaveLength(256);
    expect(rowButtons).toHaveLength(256);
    expect(completedRows[0]?.props.hidden).toBe(model.completedSlots[0]?.hidden);
    expect(completedRows[255]?.props.hidden).toBe(model.completedSlots[255]?.hidden);
    const newestRow = store.completedRows[0];
    const olderRow = store.completedRows[1];
    if (newestRow === undefined || olderRow === undefined) throw new Error('test rows are missing');
    expect(JSON.stringify(BurnMetrics({ active: false, row: newestRow }))).toContain('Earth');
    expect(JSON.stringify(BurnMetrics({ active: false, row: olderRow }))).toContain('Mars');
    expect(JSON.stringify(panel)).toContain('Completed burns · newest first');
  });

  it('moves through visible rows without wrapping and restores toggle focus on Escape', () => {
    const view = new TestBurnLogView();
    view.entries.push(entry(1), entry(2), entry(3));
    const store = createBurnLogSignalStore(view);
    const model = createBurnLogPanelModel(store);
    const focus = [vi.fn(), vi.fn(), vi.fn()];
    const toggleFocus = vi.fn();
    model.setToggleElement({ focus: toggleFocus });
    for (let index = 0; index < focus.length; index += 1) {
      const focusCallback = focus[index];
      if (focusCallback === undefined) throw new Error('test focus callback is missing');
      model.completedSlots[index]?.setElement({ focus: focusCallback });
    }
    model.toggle();

    model.completedSlots[0]?.handleKeyDown(keyboardEvent('ArrowDown'));
    expect(focus[1]).toHaveBeenCalledOnce();
    model.completedSlots[1]?.handleKeyDown(keyboardEvent('ArrowUp'));
    expect(focus[0]).toHaveBeenCalledOnce();
    model.completedSlots[0]?.handleKeyDown(keyboardEvent('End'));
    expect(focus[2]).toHaveBeenCalledOnce();
    model.completedSlots[2]?.handleKeyDown(keyboardEvent('ArrowDown'));
    expect(focus[2]).toHaveBeenCalledOnce();
    model.completedSlots[2]?.handleKeyDown(keyboardEvent('Home'));
    expect(focus[0]).toHaveBeenCalledTimes(2);
    model.completedSlots[0]?.handleKeyDown(keyboardEvent('Escape'));
    expect(model.expanded.value).toBe(false);
    expect(toggleFocus).toHaveBeenCalledOnce();
  });

  it('keeps rebound flight Commands silent while a completed-row button owns navigation keys', () => {
    const view = new TestBurnLogView();
    view.entries.push(entry(1), entry(2));
    const store = createBurnLogSignalStore(view);
    const model = createBurnLogPanelModel(store);
    const keyDownListeners: Array<(event: KeyboardInputEvent) => void> = [];
    const target = {
      addEventListener: (
        type: 'keydown' | 'keyup',
        listener: (event: KeyboardInputEvent) => void,
      ) => {
        if (type === 'keydown') keyDownListeners.push(listener);
      },
      removeEventListener: vi.fn(),
    };
    const commands: Commands = {
      rotate: vi.fn(),
      setAttitudeMode: vi.fn(),
      setTarget: vi.fn(),
      setThrottle: vi.fn(),
      setWarp: vi.fn(),
    };
    const bindings: InputBindings = {
      ...DEFAULT_GAME_SETTINGS.inputBindings,
      pitchUp: 'ArrowDown',
      pitchDown: 'ArrowUp',
      throttleIncrease: 'End',
      warpIncrease: 'Home',
    };
    const mapper = new KeyboardCommandMapper(
      target,
      commands,
      () => ({ requestedWarp: 1, throttle: 0 }),
      bindings,
    );
    const rowTarget = { tagName: 'BUTTON' } as unknown as EventTarget;

    for (const code of ['ArrowDown', 'ArrowUp', 'Home', 'End']) {
      const event: KeyboardInputEvent = {
        altKey: false,
        code,
        ctrlKey: false,
        metaKey: false,
        repeat: false,
        target: rowTarget,
        preventDefault: vi.fn(),
      };
      for (const listener of keyDownListeners) listener(event);
      model.completedSlots[0]?.handleKeyDown(event);
    }
    mapper.update();

    expect(commands.rotate).not.toHaveBeenCalled();
    expect(commands.setThrottle).not.toHaveBeenCalled();
    expect(commands.setWarp).not.toHaveBeenCalled();
    expect(commands.setAttitudeMode).not.toHaveBeenCalled();
    expect(commands.setTarget).not.toHaveBeenCalled();
  });

  it('publishes a stable live summary as active and completed state changes', () => {
    const view = new TestBurnLogView();
    const store = createBurnLogSignalStore(view);
    const model = createBurnLogPanelModel(store);

    expect(model.summary.value).toBe('No burns recorded');
    view.activeBurn = entry(1);
    store.publish();
    expect(model.summary.value).toBe('1 active burn · 0 completed burns');
    view.activeBurn = null;
    view.entries.push(entry(1));
    store.publish();
    expect(model.summary.value).toBe('1 completed burn');
  });
});
