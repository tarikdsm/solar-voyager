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

  it('accepts an already loaded session only when its action succeeded', () => {
    const scenes = new SceneManager(new FakeSession());
    const failed: SessionActionResult = { ok: false, message: 'Imported session is invalid' };

    expect(scenes.activateLoadedSession(failed)).toEqual(failed);
    expect(scenes.phase).toBe('main-menu');

    const imported: SessionActionResult = { ok: true, message: 'Session imported' };
    expect(scenes.activateLoadedSession(imported)).toEqual(imported);
    expect(scenes.phase).toBe('space');
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
    expect(scenes.activateLoadedSession({ ok: true, message: 'Session imported' })).toEqual({
      ok: false,
      message: 'Space phase is already active',
    });
    expect(session.newGameCalls).toBe(1);
    expect(session.loadCalls).toBe(0);
  });
});
