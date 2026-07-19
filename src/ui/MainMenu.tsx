import { useMemo, useState } from 'preact/hooks';

import type { SceneManager } from '../game/sceneManager.js';
import type { SessionActionResult } from '../game/sessionController.js';
import type { TutorialController } from '../game/tutorialController.js';
import {
  SessionSettingsPanel,
  type SessionActivationGuard,
  type SessionSettingsPort,
} from './SessionSettingsPanel.js';

export interface MainMenuScenePort {
  readonly canContinue: boolean;
  startNewGame(): SessionActionResult;
  continueGame(): SessionActionResult;
  activateSession(action: () => SessionActionResult): SessionActionResult;
}

export interface MainMenuModel {
  startNewGame(): SessionActionResult;
  continueGame(): SessionActionResult;
  activateSession(action: () => SessionActionResult): SessionActionResult;
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
    activateSession: (action) => enterAfter(scene.activateSession(action)),
  };
}

export interface MainMenuViewProps {
  readonly canContinue: boolean;
  readonly onContinue: () => void;
  readonly onNewGame: () => void;
  readonly activationGuard: SessionActivationGuard;
  readonly session: SessionSettingsPort | null;
  readonly status: SessionActionResult | null;
  readonly tutorial?: TutorialController | null;
}

export function MainMenuView({
  canContinue,
  activationGuard,
  onContinue,
  onNewGame,
  session,
  status,
  tutorial = null,
}: MainMenuViewProps) {
  return (
    <section class="main-menu" aria-labelledby="main-menu-title">
      <div class="main-menu-intro">
        <header class="main-menu-header">
          <p class="main-menu-kicker">A real-scale orbital sandbox</p>
          <h1 id="main-menu-title">Solar Voyager</h1>
          <p>
            Command a photon-drive spacecraft from a canonical 400 km low Earth orbit. Read the
            instruments, shape your trajectory, and cross the Solar System with real orbital
            mechanics.
          </p>
        </header>
        <ul class="main-menu-facts" aria-label="Simulation highlights">
          <li>
            <strong>Float64 n-body physics</strong>
            <span>Every major body influences your heliocentric flight.</span>
          </li>
          <li>
            <strong>Relativistic visuals</strong>
            <span>Light-time, aberration, Doppler shift, and beaming at extreme speed.</span>
          </li>
          <li>
            <strong>400 km low Earth orbit</strong>
            <span>Begin already in space and plan the first departure burn.</span>
          </li>
        </ul>
      </div>

      <div class="main-menu-launch" aria-labelledby="main-menu-launch-title">
        <h2 id="main-menu-launch-title">Begin your voyage</h2>
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

        <aside class="main-menu-quick-start" aria-labelledby="main-menu-controls-title">
          <div class="main-menu-section-heading">
            <h2 id="main-menu-controls-title">Quick flight controls</h2>
            <span>Default bindings</span>
          </div>
          <dl>
            <div>
              <dt>Attitude</dt>
              <dd>W / S · A / D · Z / C</dd>
            </div>
            <div>
              <dt>Throttle</dt>
              <dd>R / F</dd>
            </div>
            <div>
              <dt>Time warp</dt>
              <dd>= / −</dd>
            </div>
            <div>
              <dt>System map</dt>
              <dd>M</dd>
            </div>
          </dl>
          <p class="main-menu-controls">
            Bindings and visual quality are configurable in Settings.
          </p>
        </aside>

        {session === null ? null : (
          <SessionSettingsPanel
            session={session}
            activationGuard={activationGuard}
            tutorial={tutorial}
          />
        )}
      </div>
    </section>
  );
}

export interface MainMenuProps {
  readonly scene: SceneManager;
  readonly session: SessionSettingsPort | null;
  readonly onSpacePhaseEntered: () => void;
  readonly tutorial?: TutorialController | null;
}

/** Renders the accessible v1 entry point and delegates all phase changes to SceneManager. */
export function MainMenu({ scene, session, onSpacePhaseEntered, tutorial = null }: MainMenuProps) {
  const model = useMemo(
    () => createMainMenuModel(scene, onSpacePhaseEntered),
    [scene, onSpacePhaseEntered],
  );
  const [status, setStatus] = useState<SessionActionResult | null>(null);
  const publish = (result: SessionActionResult): void => setStatus(result);

  return (
    <MainMenuView
      activationGuard={model.activateSession}
      canContinue={scene.canContinue}
      onContinue={() => publish(model.continueGame())}
      onNewGame={() => publish(model.startNewGame())}
      session={session}
      status={status}
      tutorial={tutorial}
    />
  );
}
