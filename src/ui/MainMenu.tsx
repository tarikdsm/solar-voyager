import { useMemo, useState } from 'preact/hooks';

import type { SceneManager } from '../game/sceneManager.js';
import type { SessionActionResult } from '../game/sessionController.js';
import { SessionSettingsPanel, type SessionSettingsPort } from './SessionSettingsPanel.js';

export interface MainMenuScenePort {
  readonly canContinue: boolean;
  startNewGame(): SessionActionResult;
  continueGame(): SessionActionResult;
  activateLoadedSession(result: SessionActionResult): SessionActionResult;
}

export interface MainMenuModel {
  startNewGame(): SessionActionResult;
  continueGame(): SessionActionResult;
  activateLoadedSession(result: SessionActionResult): SessionActionResult;
}

export function createMainMenuModel(
  scene: MainMenuScenePort,
  onSpacePhaseEntered: () => void,
): MainMenuModel {
  const enterAfter = (result: SessionActionResult): SessionActionResult => {
    if (result.ok) onSpacePhaseEntered();
    return result;
  };
  return {
    startNewGame: () => enterAfter(scene.startNewGame()),
    continueGame: () => enterAfter(scene.continueGame()),
    activateLoadedSession: (result) => enterAfter(scene.activateLoadedSession(result)),
  };
}

export interface MainMenuViewProps {
  readonly canContinue: boolean;
  readonly onContinue: () => void;
  readonly onNewGame: () => void;
  readonly onSessionActivated: (result: SessionActionResult) => void;
  readonly session: SessionSettingsPort | null;
  readonly status: SessionActionResult | null;
}

export function MainMenuView({
  canContinue,
  onContinue,
  onNewGame,
  onSessionActivated,
  session,
  status,
}: MainMenuViewProps) {
  return (
    <section class="main-menu" aria-labelledby="main-menu-title">
      <header class="main-menu-header">
        <p class="main-menu-kicker">Realistic solar-system exploration</p>
        <h1 id="main-menu-title">Solar Voyager</h1>
        <p>
          Command a photon-drive spacecraft from a canonical 400 km low Earth orbit and navigate the
          Solar System with real orbital mechanics.
        </p>
      </header>
      <nav class="main-menu-actions" aria-label="Mission start">
        <button type="button" class="main-menu-primary" autoFocus onClick={onNewGame}>
          New Game
        </button>
        <button type="button" disabled={!canContinue} onClick={onContinue}>
          Continue
        </button>
      </nav>
      <p
        class={
          status?.ok === false ? 'main-menu-status main-menu-status-error' : 'main-menu-status'
        }
        aria-live="polite"
      >
        {status?.message ?? 'Choose a mission to begin'}
      </p>
      <p class="main-menu-controls">
        Keyboard and mouse controls are available in flight. Quality and input preferences can be
        configured before launch.
      </p>
      {session === null ? null : (
        <SessionSettingsPanel session={session} onSessionActivated={onSessionActivated} />
      )}
    </section>
  );
}

export interface MainMenuProps {
  readonly scene: SceneManager;
  readonly session: SessionSettingsPort | null;
  readonly onSpacePhaseEntered: () => void;
}

/** Renders the accessible v1 entry point and delegates all phase changes to SceneManager. */
export function MainMenu({ scene, session, onSpacePhaseEntered }: MainMenuProps) {
  const model = useMemo(
    () => createMainMenuModel(scene, onSpacePhaseEntered),
    [scene, onSpacePhaseEntered],
  );
  const [status, setStatus] = useState<SessionActionResult | null>(null);
  const publish = (result: SessionActionResult): void => setStatus(result);

  return (
    <MainMenuView
      canContinue={scene.canContinue}
      onContinue={() => publish(model.continueGame())}
      onNewGame={() => publish(model.startNewGame())}
      onSessionActivated={(result) => publish(model.activateLoadedSession(result))}
      session={session}
      status={status}
    />
  );
}
