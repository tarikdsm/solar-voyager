import { INPUT_ACTIONS, type InputAction, type InputBindings } from '../settings.js';

export { INPUT_ACTIONS };
export type { InputAction, InputBindings };

/** Number of rebindable flight actions; the width of every preallocated input state array. */
export const INPUT_ACTION_COUNT = INPUT_ACTIONS.length;

const EDITABLE_TAG_NAMES: ReadonlySet<string> = new Set(['INPUT', 'SELECT', 'TEXTAREA']);
const EDITABLE_SELECTOR = 'input, select, textarea';
const CONTENTEDITABLE_ATTRIBUTE = 'contenteditable';
const CONTENTEDITABLE_SELECTOR = `[${CONTENTEDITABLE_ATTRIBUTE}]`;

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

export interface GameKeyEvent {
  readonly defaultPrevented?: boolean;
  readonly target: EventTarget | null;
}

/** True when a keyboard event must not reach game controls. */
export function blocksGameKey(event: GameKeyEvent): boolean {
  return event.defaultPrevented === true || isEditableTarget(event.target);
}

/**
 * Resolves `KeyboardEvent.code` to a rebindable action.
 *
 * The persisted `GameSettingsV2.inputBindings` code map stays the storage
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
