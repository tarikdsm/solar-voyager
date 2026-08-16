import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';

import type { SessionActionResult } from '../game/sessionController.js';

/**
 * The real pause menu (T0112, spec §7 "Pause").
 *
 * v1 had no pause at all. The simulation halt itself lives in the frame loop —
 * this is only the dialog; see
 * `docs/superpowers/specs/2026-08-15-hud-presets-design.md` §6 for why the
 * animation loop keeps running while the sim does not.
 */

export interface PauseMenuActions {
  resume(): void;
  openSettings(): void;
  save(): SessionActionResult;
  exitToMenu(): void;
}

const FOCUSABLE_SELECTOR = 'button:not([disabled])';

export interface PauseMenuProps {
  readonly actions: PauseMenuActions;
  readonly open: boolean;
}

export function PauseMenu({ actions, open }: PauseMenuProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const resumeRef = useRef<HTMLButtonElement | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  // Layout effect, not a passive one: a modal that appears and *then* takes
  // focus a frame later is a modal a keyboard user can tab straight out of.
  useLayoutEffect(() => {
    if (!open) {
      setStatus(null);
      return;
    }
    resumeRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        // Consumed here so the input engine's Escape branch (which would toggle
        // the pause straight back on) never sees it: `blocksGameKey` honours
        // `defaultPrevented`, and this listener runs on the dialog, which bubbles
        // to `window` afterwards.
        event.preventDefault();
        actions.resume();
        return;
      }
      if (event.key !== 'Tab') return;
      const dialog = dialogRef.current;
      if (dialog === null) return;
      const focusable = dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (first === undefined || last === undefined) return;
      const active = dialog.ownerDocument.activeElement;
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
        return;
      }
      if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    const dialog = dialogRef.current;
    dialog?.addEventListener('keydown', handleKeyDown);
    return () => dialog?.removeEventListener('keydown', handleKeyDown);
  }, [open, actions]);

  return (
    <div
      id="pause-menu"
      class="pause-menu"
      role="dialog"
      aria-modal="true"
      aria-labelledby="pause-menu-title"
      hidden={!open}
      ref={dialogRef}
    >
      <div class="pause-menu-card">
        <p class="hud-kicker">Simulation halted</p>
        <h2 id="pause-menu-title">Paused</h2>
        <div class="pause-menu-actions">
          <button
            id="pause-resume"
            type="button"
            class="pause-menu-primary"
            ref={resumeRef}
            onClick={() => actions.resume()}
          >
            Resume
          </button>
          <button id="pause-settings" type="button" onClick={() => actions.openSettings()}>
            Settings
          </button>
          <button id="pause-save" type="button" onClick={() => setStatus(actions.save().message)}>
            Save session
          </button>
          <button id="pause-exit" type="button" onClick={() => actions.exitToMenu()}>
            Exit to menu
          </button>
        </div>
        <p id="pause-status" class="pause-menu-status" aria-live="polite">
          {status ?? 'Time is stopped. Nothing moves until you resume.'}
        </p>
      </div>
    </div>
  );
}
