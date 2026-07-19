import { computed, signal } from '@preact/signals';
import type { ComponentChildren, VNode } from 'preact';
import { describe, expect, it, vi } from 'vitest';

import { SystemMapController } from '../game/systemMapController.js';
import type { Commands } from '../sim/simulationSnapshot.js';
import {
  createSystemMapPanelModel,
  SystemMapKeyboardBinding,
  SystemMapPanelView,
  type SystemMapKeyboardEvent,
  type SystemMapKeyboardTarget,
} from './SystemMapPanel.js';
import { createSystemMapSignalStore } from './systemMapSignals.js';

type InspectedProps = Record<string, unknown> & { readonly children?: ComponentChildren };

const BODY_IDS = Object.freeze(['sun', 'earth', 'mars', 'jupiter']);

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

function createFixture() {
  const map = createSystemMapSignalStore(BODY_IDS, 'sun');
  const targets: Array<string | null> = [];
  const commands: Commands = {
    rotate: vi.fn(),
    setAttitudeMode: vi.fn(),
    setTarget: (bodyId) => targets.push(bodyId),
    setThrottle: vi.fn(),
    setWarp: vi.fn(),
  };
  const controller = new SystemMapController({
    bodyIds: BODY_IDS,
    initialFocusId: 'sun',
    onModeChange: (mode) => map.publishMode(mode),
    onFocusChange: (bodyId) => map.publishFocus(bodyId),
  });
  return { commands, controller, map, targets };
}

function keyboardEvent(code: string, target: EventTarget | null = null) {
  return { code, target, preventDefault: vi.fn(() => undefined) };
}

class FakeKeyboardTarget implements SystemMapKeyboardTarget {
  adds = 0;
  removes = 0;
  listener: ((event: SystemMapKeyboardEvent) => void) | null = null;

  addEventListener(_type: 'keydown', listener: (event: SystemMapKeyboardEvent) => void): void {
    this.adds += 1;
    this.listener = listener;
  }

  removeEventListener(_type: 'keydown', listener: (event: SystemMapKeyboardEvent) => void): void {
    this.removes += 1;
    if (this.listener === listener) this.listener = null;
  }
}

describe('SystemMapPanel', () => {
  it('toggles with M, exits with Escape, and restores focus deterministically', () => {
    const { commands, controller } = createFixture();
    const model = createSystemMapPanelModel(BODY_IDS, commands, controller);
    const toggleFocus = vi.fn();
    const selectFocus = vi.fn();
    model.setToggleElement({ focus: toggleFocus });
    model.setBodySelectElement({ focus: selectFocus });

    const openEvent = keyboardEvent('KeyM');
    model.handleKeyDown(openEvent);
    expect(controller.mode).toBe('system-map');
    expect(openEvent.preventDefault).toHaveBeenCalledOnce();
    expect(selectFocus).toHaveBeenCalledOnce();

    const closeEvent = keyboardEvent('Escape');
    model.handleKeyDown(closeEvent);
    expect(controller.mode).toBe('space');
    expect(closeEvent.preventDefault).toHaveBeenCalledOnce();
    expect(toggleFocus).toHaveBeenCalledOnce();

    model.handleKeyDown(keyboardEvent('Escape'));
    expect(toggleFocus).toHaveBeenCalledOnce();
  });

  it('ignores M from form and inherited contenteditable targets while keeping buttons operable', () => {
    const { commands, controller } = createFixture();
    const model = createSystemMapPanelModel(BODY_IDS, commands, controller);
    const formTarget = {
      matches: (selectors: string) => selectors.includes('input'),
    } as unknown as EventTarget;
    const directEditableTarget = {
      isContentEditable: true,
      matches: () => false,
    } as unknown as EventTarget;
    const inheritedEditableTarget = {
      isContentEditable: false,
      matches: () => false,
      closest: (selectors: string) =>
        selectors === '[contenteditable]'
          ? { getAttribute: () => '', isContentEditable: false }
          : null,
    } as unknown as EventTarget;
    const buttonTarget = {
      matches: (selectors: string) => selectors.includes('button'),
    } as unknown as EventTarget;

    model.handleKeyDown(keyboardEvent('KeyM', formTarget));
    model.handleKeyDown(keyboardEvent('KeyM', directEditableTarget));
    model.handleKeyDown(keyboardEvent('KeyM', inheritedEditableTarget));
    expect(controller.mode).toBe('space');

    model.handleKeyDown(keyboardEvent('KeyM', buttonTarget));
    expect(controller.mode).toBe('system-map');
    model.handleKeyDown(keyboardEvent('Escape', formTarget));
    expect(controller.mode).toBe('space');
  });

  it('shares every valid body selection with camera focus and navigation target', () => {
    const { commands, controller, map, targets } = createFixture();
    const model = createSystemMapPanelModel(BODY_IDS, commands, controller);

    expect(model.selectBody('jupiter')).toBe(true);
    expect(controller.focusId).toBe('jupiter');
    expect(map.signals.focusBodyId.value).toBe('jupiter');
    expect(targets).toEqual(['jupiter']);
    expect(model.selectBody('unknown')).toBe(false);
    expect(targets).toEqual(['jupiter']);
  });

  it('installs one keyboard listener across repeated attachment and removes it once', () => {
    const { commands, controller } = createFixture();
    const binding = new SystemMapKeyboardBinding(
      createSystemMapPanelModel(BODY_IDS, commands, controller),
    );
    const target = new FakeKeyboardTarget();

    expect(binding.attach(target)).toBe(true);
    expect(binding.attach(target)).toBe(false);
    expect(target.adds).toBe(1);
    target.listener?.(keyboardEvent('KeyM'));
    expect(controller.mode).toBe('system-map');
    expect(binding.dispose()).toBe(true);
    expect(binding.dispose()).toBe(false);
    expect(target.removes).toBe(1);
  });

  it('renders an always-mounted labeled selector, shared status, and prediction text', () => {
    const { commands, controller, map } = createFixture();
    const model = createSystemMapPanelModel(BODY_IDS, commands, controller);
    const targetBodyId = signal('Earth');
    const view = SystemMapPanelView({
      bodyIds: BODY_IDS,
      map,
      model,
      targetBody: targetBodyId,
      trajectoryPrediction: {
        nextClosestApproach: computed(() => '384,400 km · T−00:12:00.000'),
        impactMessage: computed(() => ''),
        impactVisible: computed(() => false),
      },
    });
    const nodes = childNodes(view.props.children);
    const toggle = nodes.find((node) => node.type === 'button');
    const panel = nodes.find((node) => node.type === 'aside');
    const label = nodes.find((node) => node.type === 'label');
    const select = nodes.find((node) => node.type === 'select');
    const options = nodes.filter((node) => node.type === 'option');

    expect(toggle?.props['aria-controls']).toBe('system-map-panel');
    expect(toggle?.props['aria-expanded']).toBe(map.display.open);
    expect(panel?.props.hidden).toBe(map.display.closed);
    expect(panel?.props['aria-labelledby']).toBe('system-map-title');
    expect(label?.props.for).toBe('system-map-body-selector');
    expect(select?.props.id).toBe('system-map-body-selector');
    expect(options.map((option) => option.props.value)).toEqual(BODY_IDS);
    expect(JSON.stringify(view)).toContain('384,400 km');
    expect(JSON.stringify(view)).toContain('Navigation target');
    expect(JSON.stringify(view)).toContain('Map focus');
  });
});
