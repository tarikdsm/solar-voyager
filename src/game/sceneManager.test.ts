import { describe, expect, it } from 'vitest';

import type { SessionActionResult } from './sessionController.js';
import { SceneManager, type SceneSessionPort } from './sceneManager.js';

class FakeSession implements SceneSessionPort {
  newGameCalls = 0;
  loadCalls = 0;
  newGameResult: SessionActionResult = { ok: true, message: 'New game started' };
  loadResult: SessionActionResult = { ok: true, message: 'Session loaded' };
  validLocalSave = false;

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

describe('SceneManager', () => {
  it('reports whether Continue has a valid local save', () => {
    const session = new FakeSession();
    const scenes = new SceneManager(session);

    expect(scenes.canContinue).toBe(false);
    session.validLocalSave = true;
    expect(scenes.canContinue).toBe(true);
  });

  it('starts in the main menu and enters space only after New Game succeeds', () => {
    const session = new FakeSession();
    const scenes = new SceneManager(session);

    expect(scenes.phase).toBe('main-menu');
    expect(scenes.startNewGame()).toEqual({ ok: true, message: 'New game started' });
    expect(scenes.phase).toBe('space');
    expect(session.newGameCalls).toBe(1);
  });

  it('retains the main menu when New Game fails', () => {
    const session = new FakeSession();
    session.newGameResult = { ok: false, message: 'Unable to start new game' };
    const scenes = new SceneManager(session);

    expect(scenes.startNewGame()).toEqual(session.newGameResult);
    expect(scenes.phase).toBe('main-menu');
  });

  it('enters space only after Continue loads a valid session', () => {
    const session = new FakeSession();
    session.loadResult = { ok: false, message: 'Saved session is invalid' };
    const scenes = new SceneManager(session);

    expect(scenes.continueGame()).toEqual(session.loadResult);
    expect(scenes.phase).toBe('main-menu');

    session.loadResult = { ok: true, message: 'Session loaded' };
    expect(scenes.continueGame()).toEqual(session.loadResult);
    expect(scenes.phase).toBe('space');
    expect(session.loadCalls).toBe(2);
  });

  it('runs a session activation only while the menu is active and transitions on success', () => {
    const scenes = new SceneManager(new FakeSession());
    const failed: SessionActionResult = { ok: false, message: 'Imported session is invalid' };
    let actionCalls = 0;

    expect(
      scenes.activateSession(() => {
        actionCalls += 1;
        return failed;
      }),
    ).toEqual(failed);
    expect(scenes.phase).toBe('main-menu');

    const imported: SessionActionResult = { ok: true, message: 'Session imported' };
    expect(
      scenes.activateSession(() => {
        actionCalls += 1;
        return imported;
      }),
    ).toEqual(imported);
    expect(scenes.phase).toBe('space');
    expect(actionCalls).toBe(2);
  });

  it('rejects repeated activation without invoking New Game or Continue again', () => {
    const session = new FakeSession();
    const scenes = new SceneManager(session);
    expect(scenes.startNewGame()).toMatchObject({ ok: true });

    expect(scenes.startNewGame()).toEqual({
      ok: false,
      message: 'Space phase is already active',
    });
    expect(scenes.continueGame()).toEqual({
      ok: false,
      message: 'Space phase is already active',
    });
    let activationCalls = 0;
    expect(
      scenes.activateSession(() => {
        activationCalls += 1;
        return { ok: true, message: 'Session imported' };
      }),
    ).toEqual({ ok: false, message: 'Space phase is already active' });
    expect(session.newGameCalls).toBe(1);
    expect(session.loadCalls).toBe(0);
    expect(activationCalls).toBe(0);
  });
});

describe('SceneManager pause sub-state and menu return - T0112', () => {
  function activeScenes() {
    const session = new FakeSession();
    const scenes = new SceneManager(session);
    expect(scenes.startNewGame().ok).toBe(true);
    return { scenes, session };
  }

  it('reports the phase and the pause sub-state as one observable state', () => {
    const { scenes } = activeScenes();

    expect(scenes.state).toBe('space');
    expect(scenes.paused).toBe(false);
    expect(scenes.pause()).toBe(true);
    expect(scenes.state).toBe('paused');
    // The phase stays two-valued: pause is a sub-state of gameplay, and every
    // `phase === 'main-menu'` branch in the UI must keep meaning what it meant.
    expect(scenes.phase).toBe('space');
    expect(scenes.resume()).toBe(true);
    expect(scenes.state).toBe('space');
  });

  it('is idempotent at both ends', () => {
    const { scenes } = activeScenes();

    expect(scenes.pause()).toBe(true);
    expect(scenes.pause()).toBe(false);
    expect(scenes.resume()).toBe(true);
    expect(scenes.resume()).toBe(false);
  });

  it('refuses to pause the main menu', () => {
    const scenes = new SceneManager(new FakeSession());

    expect(scenes.pause()).toBe(false);
    expect(scenes.state).toBe('main-menu');
  });

  it('toggles and reports the resulting flag', () => {
    const { scenes } = activeScenes();

    expect(scenes.togglePause()).toBe(true);
    expect(scenes.togglePause()).toBe(false);
    expect(scenes.paused).toBe(false);
  });

  /**
   * v1's transition was one-way by construction: nothing could move the phase
   * back, so "exit to menu" could not be built. This is the landmine T0112 owns.
   */
  it('returns to the menu and lets a new session start again', () => {
    const { scenes, session } = activeScenes();
    scenes.pause();

    expect(scenes.returnToMainMenu()).toBe(true);
    expect(scenes.state).toBe('main-menu');
    // Never "paused in the menu": there is no resume button on that screen.
    expect(scenes.paused).toBe(false);
    expect(scenes.returnToMainMenu()).toBe(false);

    session.validLocalSave = true;
    expect(scenes.canContinue).toBe(true);
    expect(scenes.startNewGame().ok).toBe(true);
    expect(scenes.state).toBe('space');
    expect(session.newGameCalls).toBe(2);
  });

  it('publishes every transition to subscribers until they unsubscribe', () => {
    const session = new FakeSession();
    const scenes = new SceneManager(session);
    const states: string[] = [];
    const unsubscribe = scenes.subscribe((state) => states.push(state));

    scenes.startNewGame();
    scenes.pause();
    scenes.resume();
    scenes.returnToMainMenu();
    unsubscribe();
    scenes.startNewGame();

    expect(states).toEqual(['space', 'paused', 'space', 'main-menu']);
  });

  it('does not publish a failed entry', () => {
    const session = new FakeSession();
    session.newGameResult = { ok: false, message: 'Unable to start new game' };
    const scenes = new SceneManager(session);
    const states: string[] = [];
    scenes.subscribe((state) => states.push(state));

    scenes.startNewGame();

    expect(states).toEqual([]);
  });
});
