import { describe, expect, it } from 'vitest';

import {
  DEFAULT_GAMEPAD_SETTINGS,
  GAMEPAD_CURVE_EXPONENT_DEFAULT,
  GAMEPAD_DEADZONE_DEFAULT,
  type GamepadSettings,
} from '../settings.js';
import { INPUT_ACTION_COUNT, actionIndex } from './bindings.js';
import {
  applyDeadzone,
  applyResponseCurve,
  GamepadPoller,
  GAMEPAD_BUTTON_BINDINGS,
  shapeGamepadAxis,
  type GamepadButtonLike,
  type GamepadHost,
  type GamepadLike,
} from './gamepad.js';

const CRUISE_ENGAGE_INDEX = actionIndex('cruiseEngage');
const CRUISE_ABORT_INDEX = actionIndex('cruiseAbort');

function neutralButtons(): GamepadButtonLike[] {
  return Array.from({ length: 17 }, () => ({ pressed: false, value: 0 }));
}

interface PadOverrides {
  readonly axes?: readonly [number, number, number, number];
  readonly buttons?: Readonly<Record<number, Partial<GamepadButtonLike>>>;
  readonly mapping?: string;
  readonly connected?: boolean;
}

function standardPad(overrides: PadOverrides = {}): GamepadLike {
  const buttons = neutralButtons();
  for (const [index, patch] of Object.entries(overrides.buttons ?? {})) {
    const existing = buttons[Number(index)];
    if (existing === undefined) continue;
    buttons[Number(index)] = { ...existing, ...patch };
  }
  return {
    connected: overrides.connected ?? true,
    mapping: overrides.mapping ?? 'standard',
    axes: overrides.axes ?? [0, 0, 0, 0],
    buttons,
  };
}

/**
 * Deep-clones a pad: a fresh object with fresh `axes`/`buttons` arrays and
 * fresh button objects. This is what makes the fake below actually defend the
 * invariant `GamepadPoller` depends on — see the class doc comment.
 */
function clonePad(pad: GamepadLike): GamepadLike {
  return {
    connected: pad.connected,
    mapping: pad.mapping,
    axes: [...pad.axes],
    buttons: pad.buttons.map((button) => ({ pressed: button.pressed, value: button.value })),
  };
}

/**
 * A faithful fake of `navigator.getGamepads()` + the window connect/disconnect
 * events: a fresh array object on every `getGamepads()` call (the documented
 * Chromium quirk this task must not choke on), and connect/disconnect
 * listeners that fire independent of any event payload — `GamepadPoller`
 * rescans by calling `getGamepads()` itself rather than reading an event
 * argument, so the fakes below deliberately pass no gamepad through the event.
 *
 * Every `getGamepads()` call also returns a **fresh `GamepadLike` object with
 * fresh `axes`/`buttons` arrays** (via `clonePad`), not the same object handed
 * back repeatedly. On real Chrome, `navigator.getGamepads()` returns fresh
 * snapshot objects every call; the single most tempting future "optimization"
 * — caching the pad object at connect time and reading `pad.axes` on each
 * `poll()` instead of re-indexing into a fresh `getGamepads()` result — would
 * pass every test here undetected if this fake handed back the same object
 * reference, because the cached reference would still happen to see updated
 * values. Cloning makes a cached reference go stale (frozen at whatever
 * `update()` last cloned from when the cache was taken), which is what would
 * actually happen against a browser that hands back fresh snapshots, so the
 * shortcut fails loudly here instead of shipping a Chrome-only bug.
 */
class FakeGamepadHost implements GamepadHost {
  getGamepadsCallCount = 0;
  private readonly slots = new Map<number, GamepadLike>();
  private readonly connectedListeners: (() => void)[] = [];
  private readonly disconnectedListeners: (() => void)[] = [];

  getGamepads(): readonly (GamepadLike | null | undefined)[] {
    this.getGamepadsCallCount += 1;
    const highestIndex = Math.max(-1, ...this.slots.keys());
    const snapshot: (GamepadLike | null)[] = [];
    for (let index = 0; index <= highestIndex; index += 1) {
      const pad = this.slots.get(index);
      snapshot.push(pad === undefined ? null : clonePad(pad));
    }
    return snapshot;
  }

  addEventListener(type: 'gamepadconnected' | 'gamepaddisconnected', listener: () => void): void {
    (type === 'gamepadconnected' ? this.connectedListeners : this.disconnectedListeners).push(
      listener,
    );
  }

  removeEventListener(
    type: 'gamepadconnected' | 'gamepaddisconnected',
    listener: () => void,
  ): void {
    const list = type === 'gamepadconnected' ? this.connectedListeners : this.disconnectedListeners;
    const index = list.indexOf(listener);
    if (index >= 0) list.splice(index, 1);
  }

  get listenerCount(): number {
    return this.connectedListeners.length + this.disconnectedListeners.length;
  }

  connect(index: number, pad: GamepadLike = standardPad()): void {
    this.slots.set(index, pad);
    for (const listener of [...this.connectedListeners]) listener();
  }

  /** Updates an already-connected slot's live state without firing a connect event. */
  update(index: number, pad: GamepadLike): void {
    this.slots.set(index, pad);
  }

  disconnect(index: number): void {
    this.slots.delete(index);
    for (const listener of [...this.disconnectedListeners]) listener();
  }
}

function newDownEdges(): { down: Uint8Array; edges: Uint8Array } {
  return { down: new Uint8Array(INPUT_ACTION_COUNT), edges: new Uint8Array(INPUT_ACTION_COUNT) };
}

describe('applyDeadzone', () => {
  it('collapses everything at or under the deadzone to exactly zero', () => {
    expect(applyDeadzone(0, 0.08)).toBe(0);
    expect(applyDeadzone(0.08, 0.08)).toBe(0);
    expect(applyDeadzone(-0.08, 0.08)).toBe(0);
    expect(applyDeadzone(0.05, 0.08)).toBe(0);
  });

  it('rescales the surviving range back onto [0, 1] so full deflection stays reachable', () => {
    expect(applyDeadzone(1, 0.08)).toBeCloseTo(1, 12);
    expect(applyDeadzone(-1, 0.08)).toBeCloseTo(-1, 12);
    // Halfway between the deadzone and full deflection maps to 0.5, not 0.46.
    const midpoint = 0.08 + (1 - 0.08) / 2;
    expect(applyDeadzone(midpoint, 0.08)).toBeCloseTo(0.5, 12);
    expect(applyDeadzone(-midpoint, 0.08)).toBeCloseTo(-0.5, 12);
  });

  it('is a no-op at zero deadzone', () => {
    expect(applyDeadzone(0.37, 0)).toBeCloseTo(0.37, 12);
    expect(applyDeadzone(-0.37, 0)).toBeCloseTo(-0.37, 12);
  });
});

describe('applyResponseCurve', () => {
  it('keeps the endpoints fixed for any positive exponent', () => {
    expect(applyResponseCurve(0, 1.6)).toBe(0);
    expect(applyResponseCurve(1, 1.6)).toBeCloseTo(1, 12);
    expect(applyResponseCurve(-1, 1.6)).toBeCloseTo(-1, 12);
  });

  it('softens small deflections below the linear diagonal for exponent > 1', () => {
    const curved = applyResponseCurve(0.5, 1.6);
    expect(curved).toBeCloseTo(0.5 ** 1.6, 12);
    expect(curved).toBeLessThan(0.5);
    expect(applyResponseCurve(-0.5, 1.6)).toBeCloseTo(-curved, 12);
  });

  it('is the identity at exponent 1', () => {
    expect(applyResponseCurve(0.42, 1)).toBeCloseTo(0.42, 12);
  });
});

describe('shapeGamepadAxis', () => {
  const noShaping = { invert: false, sensitivity: 1 };

  it('composes deadzone, curve, invert and sensitivity in that order', () => {
    expect(shapeGamepadAxis(1, 0.08, 1.6, noShaping)).toBeCloseTo(1, 12);
    expect(shapeGamepadAxis(-1, 0.08, 1.6, noShaping)).toBeCloseTo(-1, 12);
    expect(shapeGamepadAxis(0.08, 0.08, 1.6, noShaping)).toBe(0);
  });

  it('invert flips the final sign', () => {
    expect(shapeGamepadAxis(1, 0.08, 1.6, { invert: true, sensitivity: 1 })).toBeCloseTo(-1, 12);
    expect(shapeGamepadAxis(-1, 0.08, 1.6, { invert: true, sensitivity: 1 })).toBeCloseTo(1, 12);
  });

  it('sensitivity scales the shaped value and the result is clamped to [-1, 1]', () => {
    expect(shapeGamepadAxis(1, 0.08, 1.6, { invert: false, sensitivity: 0.5 })).toBeCloseTo(
      0.5,
      12,
    );
    expect(shapeGamepadAxis(1, 0.08, 1.6, { invert: false, sensitivity: 3 })).toBe(1);
    expect(shapeGamepadAxis(-1, 0.08, 1.6, { invert: false, sensitivity: 3 })).toBe(-1);
  });
});

describe('GamepadPoller — disconnected steady state', () => {
  it('never calls getGamepads while nothing has connected', () => {
    const host = new FakeGamepadHost();
    const poller = new GamepadPoller(host, DEFAULT_GAMEPAD_SETTINGS);

    for (let frame = 0; frame < 50; frame += 1) poller.poll();

    expect(host.getGamepadsCallCount).toBe(0);
    expect(poller.connected).toBe(false);
    expect(poller.pitchAxis).toBe(0);
    expect(poller.throttleActive).toBe(false);
  });

  it('does not merge anything into a fresh frame while disconnected', () => {
    const host = new FakeGamepadHost();
    const poller = new GamepadPoller(host, DEFAULT_GAMEPAD_SETTINGS);
    const { down, edges } = newDownEdges();

    poller.poll();
    poller.mergeButtonsInto(down, edges);

    expect([...down]).toEqual(new Array(INPUT_ACTION_COUNT).fill(0));
    expect([...edges]).toEqual(new Array(INPUT_ACTION_COUNT).fill(0));
  });
});

describe('GamepadPoller — connection lifecycle', () => {
  it('adopts a gamepad on connect and reads it on poll', () => {
    const host = new FakeGamepadHost();
    const poller = new GamepadPoller(host, DEFAULT_GAMEPAD_SETTINGS);

    host.connect(0, standardPad({ axes: [1, 0, 0, 0] }));
    poller.poll();

    expect(poller.connected).toBe(true);
    expect(poller.yawAxis).toBeCloseTo(1, 12);
  });

  it('stops reading after disconnect and clears the shaped sample', () => {
    const host = new FakeGamepadHost();
    const poller = new GamepadPoller(host, DEFAULT_GAMEPAD_SETTINGS);
    host.connect(0, standardPad({ axes: [1, 0, 0, 0] }));
    poller.poll();
    expect(poller.connected).toBe(true);

    host.disconnect(0);
    poller.poll();

    expect(poller.connected).toBe(false);
    expect(poller.yawAxis).toBe(0);
    const callsAfterDisconnectPoll = host.getGamepadsCallCount;
    poller.poll();
    poller.poll();
    // The disconnect event itself rescans once; steady-state polling after
    // that must not call getGamepads again while nothing is connected.
    expect(host.getGamepadsCallCount).toBe(callsAfterDisconnectPoll);
  });

  it('treats a non-standard mapping as not connected', () => {
    const host = new FakeGamepadHost();
    const poller = new GamepadPoller(host, DEFAULT_GAMEPAD_SETTINGS);

    host.connect(0, standardPad({ mapping: 'xbox-legacy' }));
    poller.poll();

    expect(poller.connected).toBe(false);
  });

  it('prefers the lowest connected index and falls back when it disconnects', () => {
    const host = new FakeGamepadHost();
    const poller = new GamepadPoller(host, DEFAULT_GAMEPAD_SETTINGS);

    host.connect(1, standardPad({ axes: [0, 0, 1, 0] }));
    host.connect(0, standardPad({ axes: [0, 0, -1, 0] }));
    poller.poll();
    expect(poller.rollAxis).toBeCloseTo(-1, 12); // index 0 wins over index 1

    host.disconnect(0);
    poller.poll();
    expect(poller.connected).toBe(true);
    expect(poller.rollAxis).toBeCloseTo(1, 12); // falls back to the remaining index 1
  });

  it('returns a fresh array reference on every getGamepads call and still works', () => {
    const host = new FakeGamepadHost();
    const poller = new GamepadPoller(host, DEFAULT_GAMEPAD_SETTINGS);
    host.connect(0, standardPad({ axes: [0, -1, 0, 0] }));

    const first = host.getGamepads();
    const second = host.getGamepads();
    expect(first).not.toBe(second);
    expect(first).toEqual(second);

    poller.poll();
    expect(poller.pitchAxis).toBeCloseTo(1, 12);
  });

  it('dispose removes both listeners', () => {
    const host = new FakeGamepadHost();
    const poller = new GamepadPoller(host, DEFAULT_GAMEPAD_SETTINGS);
    expect(host.listenerCount).toBe(2);

    poller.dispose();
    poller.dispose();

    expect(host.listenerCount).toBe(0);
  });
});

describe('GamepadPoller — standard-mapping axis wiring', () => {
  it('left stick Y feeds pitch, negated (stick away from the player = pitch up)', () => {
    const host = new FakeGamepadHost();
    const poller = new GamepadPoller(host, DEFAULT_GAMEPAD_SETTINGS);

    host.connect(0, standardPad({ axes: [0, -1, 0, 0] }));
    poller.poll();
    expect(poller.pitchAxis).toBeCloseTo(1, 12);

    host.update(0, standardPad({ axes: [0, 1, 0, 0] }));
    poller.poll();
    expect(poller.pitchAxis).toBeCloseTo(-1, 12);
  });

  it('left stick X feeds yaw directly (right = positive, matches yawRight)', () => {
    const host = new FakeGamepadHost();
    const poller = new GamepadPoller(host, DEFAULT_GAMEPAD_SETTINGS);

    host.connect(0, standardPad({ axes: [1, 0, 0, 0] }));
    poller.poll();
    expect(poller.yawAxis).toBeCloseTo(1, 12);

    host.update(0, standardPad({ axes: [-1, 0, 0, 0] }));
    poller.poll();
    expect(poller.yawAxis).toBeCloseTo(-1, 12);
  });

  it('right stick X feeds roll directly (right = positive, matches rollRight)', () => {
    const host = new FakeGamepadHost();
    const poller = new GamepadPoller(host, DEFAULT_GAMEPAD_SETTINGS);

    host.connect(0, standardPad({ axes: [0, 0, 1, 0] }));
    poller.poll();
    expect(poller.rollAxis).toBeCloseTo(1, 12);
  });

  it('all three rate axes sit inside the deadzone at rest', () => {
    const host = new FakeGamepadHost();
    const poller = new GamepadPoller(host, DEFAULT_GAMEPAD_SETTINGS);

    host.connect(0, standardPad({ axes: [0.05, -0.05, 0.05, 0] }));
    poller.poll();

    expect(poller.pitchAxis).toBe(0);
    expect(poller.yawAxis).toBe(0);
    expect(poller.rollAxis).toBe(0);
  });

  it('applySettings takes effect on the next poll', () => {
    const host = new FakeGamepadHost();
    const poller = new GamepadPoller(host, DEFAULT_GAMEPAD_SETTINGS);
    host.connect(0, standardPad({ axes: [1, 0, 0, 0] }));
    poller.poll();
    expect(poller.yawAxis).toBeCloseTo(1, 12);

    const inverted: GamepadSettings = {
      ...DEFAULT_GAMEPAD_SETTINGS,
      axes: {
        ...DEFAULT_GAMEPAD_SETTINGS.axes,
        yaw: { invert: true, sensitivity: 1 },
      },
    };
    poller.applySettings(inverted);
    poller.poll();
    expect(poller.yawAxis).toBeCloseTo(-1, 12);
  });
});

describe('GamepadPoller — trigger throttle', () => {
  it('right trigger alone drives the lever up proportionally', () => {
    const host = new FakeGamepadHost();
    const poller = new GamepadPoller(host, DEFAULT_GAMEPAD_SETTINGS);

    host.connect(0, standardPad({ buttons: { 7: { value: 1, pressed: true } } }));
    poller.poll();

    expect(poller.throttleActive).toBe(true);
    expect(poller.throttleValue).toBeCloseTo(1, 12);
  });

  it('left trigger alone cuts the lever to zero rather than going negative', () => {
    const host = new FakeGamepadHost();
    const poller = new GamepadPoller(host, DEFAULT_GAMEPAD_SETTINGS);

    host.connect(0, standardPad({ buttons: { 6: { value: 1, pressed: true } } }));
    poller.poll();

    expect(poller.throttleActive).toBe(true); // shaped value is -1, still "active"
    expect(poller.throttleValue).toBe(0); // but the lever has no reverse thrust
  });

  it('both triggers pressed equally cancel out and the axis is reported inactive', () => {
    const host = new FakeGamepadHost();
    const poller = new GamepadPoller(host, DEFAULT_GAMEPAD_SETTINGS);

    host.connect(
      0,
      standardPad({ buttons: { 6: { value: 1, pressed: true }, 7: { value: 1, pressed: true } } }),
    );
    poller.poll();

    expect(poller.throttleActive).toBe(false);
    expect(poller.throttleValue).toBe(0);
  });

  it('a trigger resting at zero is inactive, not a forced zero', () => {
    const host = new FakeGamepadHost();
    const poller = new GamepadPoller(host, DEFAULT_GAMEPAD_SETTINGS);

    host.connect(0, standardPad());
    poller.poll();

    expect(poller.throttleActive).toBe(false);
  });
});

describe('GamepadPoller — non-finite device data (review finding: sanitize at the boundary)', () => {
  // A conforming Gamepad never reports NaN/Infinity, but nothing enforces
  // that on the object a browser hands back. Left unguarded, NaN propagates
  // through shapeGamepadAxis (every early-out there is a `<=`/`===` compare,
  // which NaN always fails) and reaches InputEngine.setThrottleAxis, which
  // *throws* on a non-finite value from inside the per-frame render loop —
  // a permanent freeze, since nothing downstream of that throw reschedules
  // requestAnimationFrame. These pin the fix: a non-finite reading is treated
  // as "not deflected", not "the sim gets a NaN telling the render loop it is
  // programmer error".
  it('a NaN stick axis reports 0, not NaN', () => {
    const host = new FakeGamepadHost();
    const poller = new GamepadPoller(host, DEFAULT_GAMEPAD_SETTINGS);

    host.connect(0, standardPad({ axes: [Number.NaN, Number.NaN, Number.NaN, 0] }));
    poller.poll();

    expect(poller.pitchAxis).toBe(0);
    expect(poller.yawAxis).toBe(0);
    expect(poller.rollAxis).toBe(0);
    expect(Number.isNaN(poller.pitchAxis)).toBe(false);
  });

  it('an Infinity stick axis also reports 0', () => {
    const host = new FakeGamepadHost();
    const poller = new GamepadPoller(host, DEFAULT_GAMEPAD_SETTINGS);

    host.connect(
      0,
      standardPad({ axes: [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, 0] }),
    );
    poller.poll();

    expect(poller.yawAxis).toBe(0);
    expect(poller.pitchAxis).toBe(0);
  });

  it('a NaN trigger value never activates the throttle and never yields a NaN lever', () => {
    const host = new FakeGamepadHost();
    const poller = new GamepadPoller(host, DEFAULT_GAMEPAD_SETTINGS);

    host.connect(0, standardPad({ buttons: { 7: { value: Number.NaN, pressed: true } } }));
    poller.poll();

    expect(poller.throttleActive).toBe(false);
    expect(poller.throttleValue).toBe(0);
    expect(Number.isNaN(poller.throttleValue)).toBe(false);
  });

  it('one non-finite axis does not corrupt the others read from the same pad', () => {
    const host = new FakeGamepadHost();
    const poller = new GamepadPoller(host, DEFAULT_GAMEPAD_SETTINGS);

    host.connect(0, standardPad({ axes: [1, Number.NaN, 0, 0] })); // yaw finite, pitch NaN
    poller.poll();

    expect(poller.yawAxis).toBeCloseTo(1, 12);
    expect(poller.pitchAxis).toBe(0);
  });
});

describe('GamepadPoller — button edges and merge', () => {
  it('A is a one-poll press edge and a sustained held level, mapped to cruiseEngage', () => {
    const host = new FakeGamepadHost();
    const poller = new GamepadPoller(host, DEFAULT_GAMEPAD_SETTINGS);
    host.connect(0, standardPad({ buttons: { 0: { pressed: true } } }));

    poller.poll();
    const first = newDownEdges();
    poller.mergeButtonsInto(first.down, first.edges);
    expect(first.down[CRUISE_ENGAGE_INDEX]).toBe(1);
    expect(first.edges[CRUISE_ENGAGE_INDEX]).toBe(1);

    poller.poll(); // still pressed
    const second = newDownEdges();
    poller.mergeButtonsInto(second.down, second.edges);
    expect(second.down[CRUISE_ENGAGE_INDEX]).toBe(1);
    expect(second.edges[CRUISE_ENGAGE_INDEX]).toBe(0); // no new edge while held
  });

  it('B maps to cruiseAbort independently of A', () => {
    const host = new FakeGamepadHost();
    const poller = new GamepadPoller(host, DEFAULT_GAMEPAD_SETTINGS);
    host.connect(0, standardPad({ buttons: { 1: { pressed: true } } }));

    poller.poll();
    const { down, edges } = newDownEdges();
    poller.mergeButtonsInto(down, edges);

    expect(down[CRUISE_ABORT_INDEX]).toBe(1);
    expect(down[CRUISE_ENGAGE_INDEX]).toBe(0);
    expect(edges[CRUISE_ABORT_INDEX]).toBe(1);
  });

  it('release produces no edge and clears the level on the next poll', () => {
    const host = new FakeGamepadHost();
    const poller = new GamepadPoller(host, DEFAULT_GAMEPAD_SETTINGS);
    host.connect(0, standardPad({ buttons: { 0: { pressed: true } } }));
    poller.poll();

    host.update(0, standardPad({ buttons: { 0: { pressed: false } } }));
    poller.poll();
    const { down, edges } = newDownEdges();
    poller.mergeButtonsInto(down, edges);

    expect(down[CRUISE_ENGAGE_INDEX]).toBe(0);
    expect(edges[CRUISE_ENGAGE_INDEX]).toBe(0);
  });

  it('adds onto whatever the caller already wrote instead of overwriting it', () => {
    const host = new FakeGamepadHost();
    const poller = new GamepadPoller(host, DEFAULT_GAMEPAD_SETTINGS);
    host.connect(0, standardPad({ buttons: { 0: { pressed: true } } }));
    poller.poll();

    const { down, edges } = newDownEdges();
    down[CRUISE_ABORT_INDEX] = 1; // pretend keyboard already set an unrelated action
    edges[CRUISE_ABORT_INDEX] = 1;
    poller.mergeButtonsInto(down, edges);

    expect(down[CRUISE_ENGAGE_INDEX]).toBe(1);
    expect(down[CRUISE_ABORT_INDEX]).toBe(1);
    expect(edges[CRUISE_ABORT_INDEX]).toBe(1);
  });

  it('GAMEPAD_BUTTON_BINDINGS names exactly A -> cruiseEngage and B -> cruiseAbort', () => {
    expect(GAMEPAD_BUTTON_BINDINGS).toEqual([
      { buttonIndex: 0, action: 'cruiseEngage' },
      { buttonIndex: 1, action: 'cruiseAbort' },
    ]);
  });
});

describe('GamepadPoller — defaults sanity', () => {
  it('the shipped defaults match the brief verbatim', () => {
    expect(DEFAULT_GAMEPAD_SETTINGS.deadzone).toBe(0.08);
    expect(DEFAULT_GAMEPAD_SETTINGS.curveExponent).toBe(1.6);
    expect(GAMEPAD_DEADZONE_DEFAULT).toBe(0.08);
    expect(GAMEPAD_CURVE_EXPONENT_DEFAULT).toBe(1.6);
    for (const axis of ['pitch', 'yaw', 'roll', 'throttle'] as const) {
      expect(DEFAULT_GAMEPAD_SETTINGS.axes[axis]).toEqual({ invert: false, sensitivity: 1 });
    }
  });
});
