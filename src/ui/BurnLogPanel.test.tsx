import type { ComponentChildren, VNode } from 'preact';
import { describe, expect, it, vi } from 'vitest';

import { InputCommandBridge, ROTATION_RATE_RAD_S } from '../game/input/inputCommandBridge.js';
import {
  InputEngine,
  type InputKeyboardEvent,
  type InputKeyboardListener,
  type InputKeyboardTarget,
} from '../game/input/inputEngine.js';
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

const ROW_BUTTON_TARGET = { tagName: 'BUTTON' } as unknown as EventTarget;

function keyboardEvent(code: string): BurnLogPanelKeyboardEvent {
  return {
    code,
    preventDefault: vi.fn(),
    target: ROW_BUTTON_TARGET,
  };
}

interface DomLikeKeyboardEvent {
  altKey: boolean;
  code: string;
  ctrlKey: boolean;
  defaultPrevented: boolean;
  metaKey: boolean;
  repeat: boolean;
  shiftKey: boolean;
  target: EventTarget | null;
  preventDefault(): void;
}

/** Models the one DOM behavior this test depends on: preventDefault is observable upstream. */
function domLikeKeyboardEvent(code: string, target: EventTarget | null): DomLikeKeyboardEvent {
  const event: DomLikeKeyboardEvent = {
    altKey: false,
    code,
    ctrlKey: false,
    defaultPrevented: false,
    metaKey: false,
    repeat: false,
    shiftKey: false,
    target,
    preventDefault: () => {
      event.defaultPrevented = true;
    },
  };
  return event;
}

function createFlightInputFixture(bindings: InputBindings) {
  const keyDownListeners: InputKeyboardListener[] = [];
  const keyUpListeners: InputKeyboardListener[] = [];
  const keyboardTarget: InputKeyboardTarget = {
    addEventListener: (type: 'keydown' | 'keyup' | 'blur', listener: unknown) => {
      if (type === 'keydown') keyDownListeners.push(listener as InputKeyboardListener);
      else if (type === 'keyup') keyUpListeners.push(listener as InputKeyboardListener);
    },
    removeEventListener: vi.fn(),
  } as unknown as InputKeyboardTarget;
  const commands: Commands = {
    rotate: vi.fn(),
    setAttitudeMode: vi.fn(),
    setTarget: vi.fn(),
    setThrottle: vi.fn(),
    setWarp: vi.fn(),
  };
  const engine = new InputEngine({ bindings, keyboardTarget });
  const bridge = new InputCommandBridge(commands, () => ({ requestedWarp: 1, throttle: 0 }));
  return {
    commands,
    emitKeyDown: (event: InputKeyboardEvent) => {
      for (const listener of keyDownListeners) listener(event);
    },
    emitKeyUp: (event: InputKeyboardEvent) => {
      for (const listener of keyUpListeners) listener(event);
    },
    step: () => {
      bridge.apply(engine.poll(1 / 60));
    },
  };
}

describe('BurnLogPanel', () => {
  it('reports real expansion changes through the optional observation seam', () => {
    const store = createBurnLogSignalStore(new TestBurnLogView());
    const changes: boolean[] = [];
    const model = createBurnLogPanelModel(store, (expanded) => changes.push(expanded));

    model.toggle();
    model.toggle();

    expect(changes).toEqual([true, false]);
  });

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

  it('keeps rebound flight Commands silent while a completed-row button consumes navigation keys', () => {
    const view = new TestBurnLogView();
    view.entries.push(entry(1), entry(2));
    const model = createBurnLogPanelModel(createBurnLogSignalStore(view));
    const flight = createFlightInputFixture({
      ...DEFAULT_GAME_SETTINGS.inputBindings,
      pitchUp: 'ArrowDown',
      pitchDown: 'ArrowUp',
      throttleIncrease: 'End',
      warpIncrease: 'Home',
    });

    for (const code of ['ArrowDown', 'ArrowUp', 'Home', 'End']) {
      // Real DOM order: the focused row handles the key first and calls
      // preventDefault, so the window-level engine must stand down.
      const keyDownEvent = domLikeKeyboardEvent(code, ROW_BUTTON_TARGET);
      model.completedSlots[0]?.handleKeyDown(keyDownEvent);
      expect(keyDownEvent.defaultPrevented).toBe(true);
      flight.emitKeyDown(keyDownEvent);

      const keyUpEvent = domLikeKeyboardEvent(code, ROW_BUTTON_TARGET);
      flight.emitKeyUp(keyUpEvent);
      flight.step();
    }

    expect(flight.commands.rotate).not.toHaveBeenCalled();
    expect(flight.commands.setThrottle).not.toHaveBeenCalled();
    expect(flight.commands.setWarp).not.toHaveBeenCalled();
    expect(flight.commands.setAttitudeMode).not.toHaveBeenCalled();
    expect(flight.commands.setTarget).not.toHaveBeenCalled();
  });

  it('keeps flying while a completed-row button holds focus but ignores the key', () => {
    const view = new TestBurnLogView();
    view.entries.push(entry(1), entry(2));
    const model = createBurnLogPanelModel(createBurnLogSignalStore(view));
    const flight = createFlightInputFixture(DEFAULT_GAME_SETTINGS.inputBindings);

    // v1 froze W/A/S/D/R/F whenever any button owned focus; the row ignores KeyW,
    // so the ship must keep responding.
    const keyDownEvent = domLikeKeyboardEvent('KeyW', ROW_BUTTON_TARGET);
    model.completedSlots[0]?.handleKeyDown(keyDownEvent);
    expect(keyDownEvent.defaultPrevented).toBe(false);
    flight.emitKeyDown(keyDownEvent);
    flight.step();

    expect(flight.commands.rotate).toHaveBeenCalledWith(ROTATION_RATE_RAD_S, 0, 0);
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
