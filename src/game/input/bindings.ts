import { INPUT_ACTIONS, type InputAction, type InputBindings } from '../settings.js';

export { INPUT_ACTIONS };
export type { InputAction, InputBindings };

/** Number of rebindable flight actions; the width of every preallocated input state array. */
export const INPUT_ACTION_COUNT = INPUT_ACTIONS.length;

const EDITABLE_TAG_NAMES: ReadonlySet<string> = new Set(['INPUT', 'SELECT', 'TEXTAREA']);
const EDITABLE_SELECTOR = 'input, select, textarea';
const CONTENTEDITABLE_ATTRIBUTE = 'contenteditable';
const CONTENTEDITABLE_SELECTOR = `[${CONTENTEDITABLE_ATTRIBUTE}]`;
const ROLE_ATTRIBUTE = 'role';

/** Elements the browser activates natively from the keyboard. */
const ACTIVATION_TAG_NAMES: ReadonlySet<string> = new Set(['A', 'BUTTON', 'SUMMARY']);
const ACTIVATION_ROLES: ReadonlySet<string> = new Set([
  'button',
  'checkbox',
  'link',
  'menuitem',
  'option',
  'radio',
  'switch',
  'tab',
]);
const ACTIVATION_CODES: ReadonlySet<string> = new Set(['Enter', 'NumpadEnter', 'Space']);

const ACTION_INDICES: ReadonlyMap<InputAction, number> = buildActionIndices();

function buildActionIndices(): ReadonlyMap<InputAction, number> {
  const result = new Map<InputAction, number>();
  for (let index = 0; index < INPUT_ACTIONS.length; index += 1) {
    const action = INPUT_ACTIONS[index];
    if (action === undefined) throw new RangeError('input action list is sparse');
    result.set(action, index);
  }
  return result;
}

/** Dense array index of a rebindable action. Allocation-free; -1 when unknown. */
export function actionIndex(action: InputAction): number {
  return ACTION_INDICES.get(action) ?? -1;
}

interface EditableOwner {
  readonly isContentEditable?: unknown;
  getAttribute?: (name: string) => string | null;
}

interface EditableCandidate {
  readonly isContentEditable?: unknown;
  readonly tagName?: unknown;
  getAttribute?: (name: string) => string | null;
  matches?: (selectors: string) => boolean;
  closest?: (selectors: string) => EditableOwner | null;
}

function hasEditableContentAncestor(candidate: EditableCandidate): boolean {
  if (typeof candidate.closest !== 'function') return false;
  if (candidate.closest(EDITABLE_SELECTOR) !== null) return true;
  const owner = candidate.closest(CONTENTEDITABLE_SELECTOR);
  if (owner === null || owner === undefined) return false;
  if (owner.isContentEditable === true) return true;
  const attribute = owner.getAttribute?.(CONTENTEDITABLE_ATTRIBUTE);
  return attribute === '' || attribute?.toLowerCase() === 'true';
}

/**
 * The single UI-focus policy shared by every keyboard consumer.
 *
 * Only real text entry blocks game keys: `INPUT`, `SELECT`, `TEXTAREA` and
 * `contenteditable` subtrees. Buttons deliberately do NOT block — v1 treated
 * `BUTTON` as editable, which froze all flight input whenever any HUD button
 * held focus. A button that genuinely consumes a key calls `preventDefault()`
 * instead, which `blocksGameKey` honors.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (target === null || typeof target !== 'object') return false;
  const candidate = target as EditableCandidate;
  if (candidate.isContentEditable === true) return true;
  if (
    typeof candidate.tagName === 'string' &&
    EDITABLE_TAG_NAMES.has(candidate.tagName.toUpperCase())
  ) {
    return true;
  }
  if (typeof candidate.matches === 'function' && candidate.matches(EDITABLE_SELECTOR)) return true;
  return hasEditableContentAncestor(candidate);
}

/**
 * True when the browser would natively activate the focused control with this key.
 *
 * `Space`/`Enter` on a `<button>`, `<summary>`, link, or ARIA widget is that
 * control's own key: the browser's default action *is* the activation, and it
 * never sets `defaultPrevented`, so the generic "a control that consumed the key
 * blocks it" rule cannot see it. Without this clause, binding a flight action to
 * `Space` would let the window listener `preventDefault()` every HUD button and
 * the settings `<summary>` into silence — a keyboard-operability regression that
 * v1 avoided only because it blocked `BUTTON` outright.
 */
export function isActivationKeyForTarget(code: string, target: EventTarget | null): boolean {
  if (!ACTIVATION_CODES.has(code)) return false;
  if (target === null || typeof target !== 'object') return false;
  const candidate = target as EditableCandidate;
  if (
    typeof candidate.tagName === 'string' &&
    ACTIVATION_TAG_NAMES.has(candidate.tagName.toUpperCase())
  ) {
    return true;
  }
  const role = candidate.getAttribute?.(ROLE_ATTRIBUTE);
  return typeof role === 'string' && ACTIVATION_ROLES.has(role.toLowerCase());
}

export interface GameKeyEvent {
  readonly code?: string;
  readonly defaultPrevented?: boolean;
  readonly target: EventTarget | null;
}

/**
 * True when a keyboard event must not reach game controls.
 *
 * Three ways a key belongs to the UI instead of the ship: the player is typing,
 * a control already consumed the key explicitly, or the key is the focused
 * control's native activation key.
 */
export function blocksGameKey(event: GameKeyEvent): boolean {
  if (event.defaultPrevented === true) return true;
  if (isEditableTarget(event.target)) return true;
  return event.code !== undefined && isActivationKeyForTarget(event.code, event.target);
}

/**
 * Resolves `KeyboardEvent.code` to a rebindable action.
 *
 * The persisted `GameSettingsV3.inputBindings` code map stays the storage
 * format; this table is its runtime index and is rebuilt only when settings
 * change, never per frame.
 */
export class BindingTable {
  private codes = new Map<string, InputAction>();

  constructor(bindings: InputBindings) {
    this.rebuild(bindings);
  }

  /** Allocation-free lookup used from the event path. */
  resolve(code: string): InputAction | undefined {
    return this.codes.get(code);
  }

  rebuild(bindings: InputBindings): void {
    const next = new Map<string, InputAction>();
    for (let index = 0; index < INPUT_ACTIONS.length; index += 1) {
      const action = INPUT_ACTIONS[index];
      if (action === undefined) throw new RangeError('input action list is sparse');
      const code = bindings[action];
      if (next.has(code)) throw new RangeError(`input code ${code} is already bound`);
      next.set(code, action);
    }
    this.codes = next;
  }
}
