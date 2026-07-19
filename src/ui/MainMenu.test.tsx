import type { ComponentChildren, VNode } from 'preact';
import { describe, expect, it } from 'vitest';

import type { SessionActionResult } from '../game/sessionController.js';
import { SceneManager, type SceneSessionPort } from '../game/sceneManager.js';
import { createMainMenuModel, MainMenuView } from './MainMenu.js';
import { SessionSettingsPanel, type SessionSettingsPort } from './SessionSettingsPanel.js';

type InspectedProps = Record<string, unknown> & { readonly children?: ComponentChildren };

class FakeSession implements SceneSessionPort {
  validLocalSave = false;
  newGameResult: SessionActionResult = { ok: true, message: 'New game started' };
  loadResult: SessionActionResult = { ok: true, message: 'Session loaded' };
  newGameCalls = 0;
  loadCalls = 0;

  hasValidLocalSave(): boolean {
    return this.validLocalSave;
  }

  startNewGame(): SessionActionResult {
    this.newGameCalls += 1;
    return this.newGameResult;
  }

  loadLocal(): SessionActionResult {
    this.loadCalls += 1;
    return this.loadResult;
  }
}

function childNodes(children: ComponentChildren): VNode<InspectedProps>[] {
  const pending = Array.isArray(children) ? [...children] : [children];
  const nodes: VNode<InspectedProps>[] = [];
  while (pending.length > 0) {
    const value = pending.shift();
    if (Array.isArray(value)) {
      pending.unshift(...value);
    } else if (value !== null && typeof value === 'object' && 'type' in value) {
      const node = value as VNode<InspectedProps>;
      nodes.push(node);
      pending.unshift(
        ...(Array.isArray(node.props.children) ? node.props.children : [node.props.children]),
      );
    }
  }
  return nodes;
}

describe('main menu', () => {
  it('activates space once after New Game succeeds and retains failures in the menu', () => {
    const session = new FakeSession();
    const scenes = new SceneManager(session);
    const activations: string[] = [];
    const model = createMainMenuModel(scenes, () => activations.push('space'));

    session.newGameResult = { ok: false, message: 'Unable to start new game' };
    expect(model.startNewGame()).toEqual(session.newGameResult);
    expect(scenes.phase).toBe('main-menu');
    expect(activations).toEqual([]);

    session.newGameResult = { ok: true, message: 'New game started' };
    expect(model.startNewGame()).toEqual(session.newGameResult);
    expect(model.startNewGame()).toEqual({
      ok: false,
      message: 'Space phase is already active',
    });
    expect(session.newGameCalls).toBe(2);
    expect(activations).toEqual(['space']);
  });

  it('offers semantic keyboard-first navigation and disables Continue without a save', () => {
    const view = MainMenuView({
      activationGuard: (action) => action(),
      canContinue: false,
      onContinue: () => undefined,
      onNewGame: () => undefined,
      session: null,
      status: { ok: false, message: 'Unable to start new game' },
    });
    const nodes = childNodes(view.props.children);
    const nav = nodes.find((node) => node.type === 'nav');
    const buttons = nodes.filter((node) => node.type === 'button');
    const newGame = buttons.find((node) => node.props.children === 'New Game');
    const continueGame = buttons.find((node) => node.props.children === 'Continue');
    const liveStatus = nodes.find((node) => node.props['aria-live'] === 'polite');

    expect(nav?.props['aria-label']).toBe('Mission start');
    expect(newGame?.props.autoFocus).toBe(true);
    expect(continueGame?.props.disabled).toBe(true);
    expect(liveStatus?.props.children).toBe('Unable to start new game');
    const serialized = JSON.stringify(view);
    expect(serialized).toContain('400 km low Earth orbit');
    expect(serialized).toContain('Float64 n-body physics');
    expect(serialized).toContain('Relativistic visuals');
    expect(serialized).toContain('Quick flight controls');
    expect(serialized).toContain('Default bindings');
    expect(nodes.filter((node) => node.type === 'li')).toHaveLength(3);
    expect(nodes.some((node) => node.type === 'dl')).toBe(true);
  });

  it('routes Continue through the scene manager only while the menu is active', () => {
    const session = new FakeSession();
    session.validLocalSave = true;
    const scenes = new SceneManager(session);
    const activations: string[] = [];
    const model = createMainMenuModel(scenes, () => activations.push('space'));

    expect(model.continueGame()).toEqual({ ok: true, message: 'Session loaded' });
    expect(model.continueGame()).toEqual({
      ok: false,
      message: 'Space phase is already active',
    });
    expect(session.loadCalls).toBe(1);
    expect(activations).toEqual(['space']);
  });

  it('bridges a loaded or imported session into space once and keeps settings available', () => {
    const scenes = new SceneManager(new FakeSession());
    const activations: string[] = [];
    const model = createMainMenuModel(scenes, () => activations.push('space'));
    const loaded: SessionActionResult = { ok: true, message: 'Session loaded' };

    expect(model.activateSession(() => loaded)).toEqual(loaded);
    let repeatedActionCalls = 0;
    expect(
      model.activateSession(() => {
        repeatedActionCalls += 1;
        return { ok: true, message: 'Session imported' };
      }),
    ).toEqual({
      ok: false,
      message: 'Space phase is already active',
    });
    expect(activations).toEqual(['space']);
    expect(repeatedActionCalls).toBe(0);

    const view = MainMenuView({
      activationGuard: model.activateSession,
      canContinue: true,
      onContinue: () => undefined,
      onNewGame: () => undefined,
      session: {} as SessionSettingsPort,
      status: null,
    });
    const settingsPanel = childNodes(view.props.children).find(
      (node) => (node.type as unknown) === SessionSettingsPanel,
    );
    expect(settingsPanel).toBeDefined();
    expect(settingsPanel?.props.activationGuard).toBeTypeOf('function');
  });
});
