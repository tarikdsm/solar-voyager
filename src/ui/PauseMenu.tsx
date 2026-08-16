import { useLayoutEffect, useRef, useState } from 'preact/hooks';

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

/** Everything the browser can focus; ordered as the DOM orders it. */
const FOCUSABLE_SELECTOR =
  'button:not([disabled]), summary, select:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

export interface PauseMenuProps {
  readonly actions: PauseMenuActions;
  readonly open: boolean;
  /**
   * Element the Tab cycle is confined to.
   *
   * The dialog is not the whole paused surface: **Settings** expands the session
   * panel, which lives beside the dialog rather than inside it (one settings UI,
   * not two, and a second `id="session-settings"` would be worse than this).
   * Trapping inside the card alone would make that panel unreachable by
   * keyboard, so the caller passes the wrapper holding both. Defaults to the
   * dialog when absent.
   */
  readonly trapRootRef?: { current: HTMLElement | null };
}

/** What a Tab press should do, decided without touching the DOM. */
export interface FocusTrapStep {
  /** True when the browser's own focus move must be replaced. */
  readonly preventDefault: boolean;
  /** Index in the focusable list to focus, or null to leave the browser alone. */
  readonly focusIndex: number | null;
}

const NO_TRAP_STEP: FocusTrapStep = Object.freeze({ preventDefault: false, focusIndex: null });

/**
 * The focus trap, as arithmetic.
 *
 * Extracted so it is testable: this repo's Vitest runs without a DOM (see
 * `App.test.tsx` and `BurnLogPanel.test.tsx`, which both inspect structure
 * rather than render), and the wrapping rules are exactly the part that was
 * wrong often enough to deserve a test. The component below is a thin adapter
 * over this; the browser gate covers the DOM half.
 *
 * `activeIndex < 0` means focus is outside the trap entirely — it gets pulled
 * back in rather than left to wander, which is the case that let Tab reach the
 * tutorial overlay.
 */
export function resolveFocusTrapStep(
  focusableCount: number,
  activeIndex: number,
  shiftKey: boolean,
): FocusTrapStep {
  if (focusableCount <= 0) return NO_TRAP_STEP;
  const last = focusableCount - 1;
  if (activeIndex < 0 || activeIndex > last) {
    return { preventDefault: true, focusIndex: shiftKey ? last : 0 };
  }
  if (shiftKey && activeIndex === 0) return { preventDefault: true, focusIndex: last };
  if (!shiftKey && activeIndex === last) return { preventDefault: true, focusIndex: 0 };
  return NO_TRAP_STEP;
}

function focusableWithin(root: HTMLElement): HTMLElement[] {
  const found: HTMLElement[] = [];
  for (const element of root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)) {
    // `offsetParent` is null for `display: none` subtrees, which is exactly the
    // collapsed `<details>` body and the closed dialog.
    if (element.offsetParent !== null || element === root) found.push(element);
  }
  return found;
}

export function PauseMenu({ actions, open, trapRootRef }: PauseMenuProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const resumeRef = useRef<HTMLButtonElement | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  /**
   * The handler is held in a ref and the listener depends only on `open`.
   *
   * `actions` is rebuilt by the parent on every render, so listing it in the
   * dependencies tore the listener down and re-added it continuously — which is
   * what made the attach/keypress race observable: a Tab arriving in the gap
   * reached the HUD behind the dialog. One attach per open, and the ref keeps
   * the callbacks current.
   */
  const handlerRef = useRef<(event: KeyboardEvent) => void>(() => undefined);
  handlerRef.current = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      // Consumed here so the input engine's Escape branch never sees it:
      // `blocksGameKey` honours `defaultPrevented`.
      event.preventDefault();
      actions.resume();
      return;
    }
    if (event.key !== 'Tab') return;
    const root = trapRootRef?.current ?? dialogRef.current;
    if (root === null) return;
    const focusable = focusableWithin(root);
    const active = root.ownerDocument.activeElement;
    const activeIndex = active instanceof HTMLElement ? focusable.indexOf(active) : -1;
    const step = resolveFocusTrapStep(focusable.length, activeIndex, event.shiftKey);
    if (!step.preventDefault || step.focusIndex === null) return;
    event.preventDefault();
    focusable[step.focusIndex]?.focus();
  };

  /**
   * Layout effect, not a passive one, for both the listener and the focus move.
   *
   * A modal that appears and *then* arms itself a frame later is a modal a
   * keyboard user can tab straight out of, and the passive version did exactly
   * that four times out of four in the production build. Running before paint
   * means no frame exists in which the dialog is visible but unguarded.
   *
   * The listener sits on the document, not the dialog: while the settings panel
   * is open, focus is legitimately outside the dialog subtree, and a
   * dialog-scoped listener would never see the keypress.
   */
  useLayoutEffect(() => {
    if (!open) {
      setStatus(null);
      return undefined;
    }
    const dialog = dialogRef.current;
    const ownerDocument = dialog?.ownerDocument ?? globalThis.document;
    const listener = (event: KeyboardEvent): void => handlerRef.current(event);
    ownerDocument.addEventListener('keydown', listener);
    resumeRef.current?.focus();
    return () => ownerDocument.removeEventListener('keydown', listener);
  }, [open]);

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
