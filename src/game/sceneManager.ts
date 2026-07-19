import type { SessionActionResult } from './sessionController.js';

export type GamePhase = 'main-menu' | 'space';

export interface SceneSessionPort {
  hasValidLocalSave(): boolean;
  startNewGame(): SessionActionResult;
  loadLocal(): SessionActionResult;
}

const ALREADY_ACTIVE_RESULT: SessionActionResult = Object.freeze({
  ok: false,
  message: 'Space phase is already active',
});

/** Owns the one-way v1 transition from the main menu into gameplay. */
export class SceneManager {
  private currentPhase: GamePhase = 'main-menu';

  constructor(private readonly session: SceneSessionPort) {}

  get phase(): GamePhase {
    return this.currentPhase;
  }

  get canContinue(): boolean {
    return this.currentPhase === 'main-menu' && this.session.hasValidLocalSave();
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

  private enterSpaceAfter(result: SessionActionResult): SessionActionResult {
    if (result.ok) this.currentPhase = 'space';
    return result;
  }
}
