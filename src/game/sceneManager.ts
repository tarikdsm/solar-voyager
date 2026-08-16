import type { SessionActionResult } from './sessionController.js';

export type GamePhase = 'main-menu' | 'space';

/**
 * Observable scene state: the phase, plus the paused sub-state of `space`.
 *
 * `GamePhase` deliberately stays two-valued. Pause is a *sub*-state of gameplay,
 * not a third phase: everything that branches on the phase (`App`, `MainMenu`,
 * their tests) cares only about "menu or world", and a paused session is still
 * the world. Flattening the pair here gives observers — and
 * `canvas.dataset.sceneState`, which browser gates read — one string to match on
 * without teaching the phase enum a distinction it does not need.
 */
export type SceneState = 'main-menu' | 'space' | 'paused';

export type SceneStateListener = (state: SceneState) => void;

export interface SceneSessionPort {
  hasValidLocalSave(): boolean;
  startNewGame(): SessionActionResult;
  loadLocal(): SessionActionResult;
}

const ALREADY_ACTIVE_RESULT: SessionActionResult = Object.freeze({
  ok: false,
  message: 'Space phase is already active',
});

/**
 * Owns the transition between the main menu and gameplay, and the pause sub-state.
 *
 * v1's transition was one-way by construction: once `phase` became `space` there
 * was no method that could move it back, so "exit to menu" could not be built on
 * top of it. T0112 makes the return real ({@link returnToMainMenu}) because the
 * pause menu needs it, and adds the pause sub-state the frame loop reads to stop
 * advancing the simulation.
 *
 * Re-entering the world after a return does **not** rebuild runtime resources:
 * `main.ts` memoises space-phase activation, and `RuntimeResourceCounts` is the
 * CI contract that says one input engine, one camera controller pair and one
 * animation loop exist per page load.
 */
export class SceneManager {
  private currentPhase: GamePhase = 'main-menu';
  private pausedState = false;
  private readonly listeners = new Set<SceneStateListener>();

  constructor(private readonly session: SceneSessionPort) {}

  get phase(): GamePhase {
    return this.currentPhase;
  }

  get state(): SceneState {
    if (this.currentPhase !== 'space') return 'main-menu';
    return this.pausedState ? 'paused' : 'space';
  }

  get paused(): boolean {
    return this.pausedState;
  }

  get canContinue(): boolean {
    return this.currentPhase === 'main-menu' && this.session.hasValidLocalSave();
  }

  /** Subscribes to state changes; returns the unsubscribe handle. */
  subscribe(listener: SceneStateListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  startNewGame(): SessionActionResult {
    if (this.currentPhase === 'space') return ALREADY_ACTIVE_RESULT;
    return this.enterSpaceAfter(this.session.startNewGame());
  }

  continueGame(): SessionActionResult {
    if (this.currentPhase === 'space') return ALREADY_ACTIVE_RESULT;
    return this.enterSpaceAfter(this.session.loadLocal());
  }

  activateSession(action: () => SessionActionResult): SessionActionResult {
    if (this.currentPhase === 'space') return ALREADY_ACTIVE_RESULT;
    return this.enterSpaceAfter(action());
  }

  /** Halts gameplay. Returns false when already paused or not in the world. */
  pause(): boolean {
    if (this.currentPhase !== 'space' || this.pausedState) return false;
    this.pausedState = true;
    this.publish();
    return true;
  }

  /** Resumes gameplay. Returns false when nothing was paused. */
  resume(): boolean {
    if (!this.pausedState) return false;
    this.pausedState = false;
    this.publish();
    return true;
  }

  /** Pause on, pause off. Returns the resulting paused flag. */
  togglePause(): boolean {
    if (this.pausedState) {
      this.resume();
      return false;
    }
    return this.pause();
  }

  /**
   * Leaves the world for the main menu.
   *
   * The pause flag is cleared on the way out so the menu is never "paused":
   * `main.ts` keeps the simulation halted for the whole time the phase is
   * `main-menu` anyway, and leaving both flags set would make "resume" a
   * reachable state from a screen that has no resume button.
   */
  returnToMainMenu(): boolean {
    if (this.currentPhase !== 'space') return false;
    this.currentPhase = 'main-menu';
    this.pausedState = false;
    this.publish();
    return true;
  }

  private enterSpaceAfter(result: SessionActionResult): SessionActionResult {
    if (!result.ok) return result;
    this.currentPhase = 'space';
    this.pausedState = false;
    this.publish();
    return result;
  }

  private publish(): void {
    const state = this.state;
    for (const listener of this.listeners) listener(state);
  }
}
