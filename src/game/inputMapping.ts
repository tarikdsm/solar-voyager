import { WARP_LADDER, type WarpFactor } from '../core/time.js';
import type { Commands } from '../sim/simulationSnapshot.js';
import { INPUT_ACTIONS, type InputAction, type InputBindings } from './settings.js';

export const ROTATION_RATE_RAD_S = 0.6;
const THROTTLE_STEP = 0.1;

export interface KeyboardInputEvent {
  readonly altKey: boolean;
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly repeat: boolean;
  readonly target: EventTarget | null;
  preventDefault(): void;
}

export type KeyboardInputListener = (event: KeyboardInputEvent) => void;

export interface KeyboardInputTarget {
  addEventListener(type: 'keydown' | 'keyup', listener: KeyboardInputListener): void;
  removeEventListener(type: 'keydown' | 'keyup', listener: KeyboardInputListener): void;
}

export interface InputCommandSnapshot {
  readonly requestedWarp: WarpFactor;
  readonly throttle: number;
}

export type InputCommandSnapshotProvider = () => InputCommandSnapshot;

function isEditableTarget(target: EventTarget | null): boolean {
  if (target === null || typeof target !== 'object') return false;
  const candidate = target as unknown as {
    readonly isContentEditable?: unknown;
    readonly tagName?: unknown;
  };
  if (candidate.isContentEditable === true) return true;
  if (typeof candidate.tagName !== 'string') return false;
  const tagName = candidate.tagName.toUpperCase();
  return (
    tagName === 'INPUT' || tagName === 'SELECT' || tagName === 'TEXTAREA' || tagName === 'BUTTON'
  );
}

function buildCodeMap(bindings: InputBindings): ReadonlyMap<string, InputAction> {
  const result = new Map<string, InputAction>();
  for (let index = 0; index < INPUT_ACTIONS.length; index += 1) {
    const action = INPUT_ACTIONS[index];
    if (action === undefined) throw new RangeError('input action list is sparse');
    const code = bindings[action];
    if (result.has(code)) throw new RangeError(`input code ${code} is already bound`);
    result.set(code, action);
  }
  return result;
}

/** Maps rebindable keyboard actions into the stable simulation Commands facade. */
export class KeyboardCommandMapper {
  private codeMap: ReadonlyMap<string, InputAction>;
  private disposed = false;
  private pitchUp = 0;
  private pitchDown = 0;
  private yawLeft = 0;
  private yawRight = 0;
  private rollLeft = 0;
  private rollRight = 0;
  private axesDirty = false;

  private readonly handleKeyDown = (event: KeyboardInputEvent): void => {
    if (
      event.repeat ||
      event.ctrlKey ||
      event.altKey ||
      event.metaKey ||
      isEditableTarget(event.target)
    ) {
      return;
    }
    const action = this.codeMap.get(event.code);
    if (action === undefined) return;
    event.preventDefault();
    if (this.setHeld(action, 1)) return;
    const snapshot = this.snapshotProvider();
    switch (action) {
      case 'throttleIncrease':
        this.commands.setThrottle(Math.min(1, snapshot.throttle + THROTTLE_STEP));
        break;
      case 'throttleDecrease':
        this.commands.setThrottle(Math.max(0, snapshot.throttle - THROTTLE_STEP));
        break;
      case 'warpIncrease':
        this.stepWarp(snapshot.requestedWarp, 1);
        break;
      case 'warpDecrease':
        this.stepWarp(snapshot.requestedWarp, -1);
        break;
      case 'attitudeManual':
        this.commands.setAttitudeMode('manual');
        break;
      case 'attitudePrograde':
        this.commands.setAttitudeMode('prograde');
        break;
      case 'attitudeRetrograde':
        this.commands.setAttitudeMode('retrograde');
        break;
      default:
        break;
    }
  };

  private readonly handleKeyUp = (event: KeyboardInputEvent): void => {
    const action = this.codeMap.get(event.code);
    if (action === undefined || !this.setHeld(action, 0)) return;
    event.preventDefault();
  };

  constructor(
    private readonly keyboardTarget: KeyboardInputTarget,
    private commands: Commands,
    private snapshotProvider: InputCommandSnapshotProvider,
    bindings: InputBindings,
  ) {
    this.codeMap = buildCodeMap(bindings);
    keyboardTarget.addEventListener('keydown', this.handleKeyDown);
    keyboardTarget.addEventListener('keyup', this.handleKeyUp);
  }

  /** Updates continuous axes once per frame without allocating. */
  update(): void {
    if (!this.axesDirty) return;
    this.commands.rotate(
      (this.pitchUp - this.pitchDown) * ROTATION_RATE_RAD_S,
      (this.yawRight - this.yawLeft) * ROTATION_RATE_RAD_S,
      (this.rollRight - this.rollLeft) * ROTATION_RATE_RAD_S,
    );
    this.axesDirty = false;
  }

  updateBindings(bindings: InputBindings): void {
    this.releaseHeldAxes();
    this.codeMap = buildCodeMap(bindings);
  }

  /** Replaces restored bindings without overwriting restored continuous commands. */
  restoreBindings(bindings: InputBindings): void {
    this.resetHeldAxes();
    this.codeMap = buildCodeMap(bindings);
  }

  updateCommands(commands: Commands, snapshotProvider: InputCommandSnapshotProvider): void {
    this.releaseHeldAxes();
    this.commands = commands;
    this.snapshotProvider = snapshotProvider;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.releaseHeldAxes();
    this.keyboardTarget.removeEventListener('keydown', this.handleKeyDown);
    this.keyboardTarget.removeEventListener('keyup', this.handleKeyUp);
  }

  private setHeld(action: InputAction, value: 0 | 1): boolean {
    switch (action) {
      case 'pitchUp':
        this.pitchUp = value;
        this.axesDirty = true;
        return true;
      case 'pitchDown':
        this.pitchDown = value;
        this.axesDirty = true;
        return true;
      case 'yawLeft':
        this.yawLeft = value;
        this.axesDirty = true;
        return true;
      case 'yawRight':
        this.yawRight = value;
        this.axesDirty = true;
        return true;
      case 'rollLeft':
        this.rollLeft = value;
        this.axesDirty = true;
        return true;
      case 'rollRight':
        this.rollRight = value;
        this.axesDirty = true;
        return true;
      default:
        return false;
    }
  }

  private releaseHeldAxes(): void {
    this.resetHeldAxes();
    this.commands.rotate(0, 0, 0);
  }

  private resetHeldAxes(): void {
    this.pitchUp = 0;
    this.pitchDown = 0;
    this.yawLeft = 0;
    this.yawRight = 0;
    this.rollLeft = 0;
    this.rollRight = 0;
    this.axesDirty = false;
  }

  private stepWarp(currentWarp: WarpFactor, direction: -1 | 1): void {
    const currentIndex = WARP_LADDER.indexOf(currentWarp);
    const nextIndex = Math.min(WARP_LADDER.length - 1, Math.max(0, currentIndex + direction));
    const nextWarp = WARP_LADDER[nextIndex];
    if (nextWarp !== undefined) this.commands.setWarp(nextWarp);
  }
}
