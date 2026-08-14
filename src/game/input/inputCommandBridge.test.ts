import { describe, expect, it, vi } from 'vitest';

import type { WarpFactor } from '../../core/time.js';
import { createCommandController } from '../../sim/simulationSnapshot.js';
import type { Commands } from '../../sim/simulationSnapshot.js';
import {
  InputCommandBridge,
  ROTATION_RATE_RAD_S,
  type InputCommandSnapshot,
} from './inputCommandBridge.js';
import type { InputAction, InputFrame } from './inputEngine.js';

class StubFrame implements InputFrame {
  lookYawRad = 0;
  lookPitchRad = 0;
  readonly axes = { pitch: 0, yaw: 0, roll: 0, throttle: 0 };
  private readonly presses = new Map<InputAction, number>();

  press(action: InputAction, count = 1): this {
    this.presses.set(action, count);
    return this;
  }

  clearPresses(): this {
    this.presses.clear();
    return this;
  }

  pressed(action: InputAction): boolean {
    return this.pressCount(action) > 0;
  }

  pressCount(action: InputAction): number {
    return this.presses.get(action) ?? 0;
  }

  held(action: InputAction): boolean {
    return this.pressed(action);
  }
}

function createStubCommands(): Commands {
  return {
    rotate: vi.fn(),
    setAttitudeMode: vi.fn(),
    setTarget: vi.fn(),
    setThrottle: vi.fn(),
    setWarp: vi.fn(),
  };
}

function snapshotOf(throttle: number, requestedWarp: WarpFactor = 1): InputCommandSnapshot {
  return { requestedWarp, throttle };
}

describe('InputCommandBridge', () => {
  it('scales axes into manual rotation rates and flushes only on change', () => {
    const commands = createStubCommands();
    const bridge = new InputCommandBridge(commands, () => snapshotOf(0));
    const frame = new StubFrame();

    frame.axes.pitch = 1;
    frame.axes.yaw = -1;
    frame.axes.roll = 1;
    bridge.apply(frame);
    expect(commands.rotate).toHaveBeenCalledWith(
      ROTATION_RATE_RAD_S,
      -ROTATION_RATE_RAD_S,
      ROTATION_RATE_RAD_S,
    );

    bridge.apply(frame);
    bridge.apply(frame);
    expect(commands.rotate).toHaveBeenCalledTimes(1);

    frame.axes.pitch = 0;
    bridge.apply(frame);
    expect(commands.rotate).toHaveBeenLastCalledWith(0, -ROTATION_RATE_RAD_S, ROTATION_RATE_RAD_S);
    expect(commands.rotate).toHaveBeenCalledTimes(2);
  });

  it('never commands rotation for an idle frame', () => {
    const commands = createStubCommands();
    const bridge = new InputCommandBridge(commands, () => snapshotOf(0));

    bridge.apply(new StubFrame());

    expect(commands.rotate).not.toHaveBeenCalled();
    expect(commands.setThrottle).not.toHaveBeenCalled();
    expect(commands.setWarp).not.toHaveBeenCalled();
    expect(commands.setAttitudeMode).not.toHaveBeenCalled();
  });

  it('preserves restored rotation rates until the player moves an axis', () => {
    const controller = createCommandController(['earth']);
    controller.commands.rotate(0.1, 0.2, 0.3);
    const bridge = new InputCommandBridge(controller.commands, () =>
      snapshotOf(controller.state.throttle, controller.state.requestedWarp),
    );
    const frame = new StubFrame();

    bridge.resetAxes();
    bridge.apply(frame);
    expect([...controller.state.rotationRatesRadS]).toEqual([0.1, 0.2, 0.3]);

    frame.axes.pitch = 1;
    bridge.apply(frame);
    expect([...controller.state.rotationRatesRadS]).toEqual([ROTATION_RATE_RAD_S, 0, 0]);

    frame.axes.pitch = 0;
    bridge.apply(frame);
    expect([...controller.state.rotationRatesRadS]).toEqual([0, 0, 0]);
  });

  it('commands the analog lever whenever it differs from the simulation', () => {
    const controller = createCommandController(['earth']);
    const bridge = new InputCommandBridge(controller.commands, () =>
      snapshotOf(controller.state.throttle, controller.state.requestedWarp),
    );
    const frame = new StubFrame();

    frame.axes.throttle = 0.37;
    bridge.apply(frame);
    expect(controller.state.throttle).toBeCloseTo(0.37, 12);

    bridge.apply(frame);
    expect(controller.state.throttle).toBeCloseTo(0.37, 12);

    frame.axes.throttle = 0;
    bridge.apply(frame);
    expect(controller.state.throttle).toBe(0);
  });

  it('restores the held lever once warp drops back below the thrust ceiling', () => {
    const controller = createCommandController(['earth']);
    const bridge = new InputCommandBridge(controller.commands, () =>
      snapshotOf(controller.state.throttle, controller.state.requestedWarp),
    );
    const frame = new StubFrame();

    frame.axes.throttle = 0.6;
    bridge.apply(frame);
    expect(controller.state.throttle).toBeCloseTo(0.6, 12);

    controller.commands.setWarp(100_000);
    expect(controller.state.throttle).toBe(0);
    bridge.apply(frame);
    expect(controller.state.throttle).toBe(0);

    controller.commands.setWarp(1);
    bridge.apply(frame);
    expect(controller.state.throttle).toBeCloseTo(0.6, 12);
  });

  it('walks the warp ladder once per press, including two presses in one frame', () => {
    const controller = createCommandController(['earth']);
    const bridge = new InputCommandBridge(controller.commands, () =>
      snapshotOf(controller.state.throttle, controller.state.requestedWarp),
    );

    bridge.apply(new StubFrame().press('warpIncrease'));
    expect(controller.state.requestedWarp).toBe(5);

    bridge.apply(new StubFrame().press('warpIncrease', 2));
    expect(controller.state.requestedWarp).toBe(50);

    bridge.apply(new StubFrame().press('warpDecrease', 3));
    expect(controller.state.requestedWarp).toBe(1);

    bridge.apply(new StubFrame().press('warpDecrease'));
    expect(controller.state.requestedWarp).toBe(1);
  });

  it('binds the three attitude actions on their press edge', () => {
    const controller = createCommandController(['earth']);
    const bridge = new InputCommandBridge(controller.commands, () =>
      snapshotOf(controller.state.throttle, controller.state.requestedWarp),
    );

    bridge.apply(new StubFrame().press('attitudePrograde'));
    expect(controller.state.attitudeMode).toBe('prograde');
    bridge.apply(new StubFrame().press('attitudeRetrograde'));
    expect(controller.state.attitudeMode).toBe('retrograde');
    bridge.apply(new StubFrame().press('attitudeManual'));
    expect(controller.state.attitudeMode).toBe('manual');
  });

  it('zeroes the abandoned session and retargets after a simulation replacement', () => {
    const original = createCommandController(['earth']);
    const replacement = createCommandController(['earth']);
    const bridge = new InputCommandBridge(original.commands, () =>
      snapshotOf(original.state.throttle, original.state.requestedWarp),
    );
    const frame = new StubFrame();

    frame.axes.yaw = 1;
    bridge.apply(frame);
    expect(original.state.rotationRatesRadS[1]).toBe(ROTATION_RATE_RAD_S);

    bridge.updateCommands(replacement.commands, () =>
      snapshotOf(replacement.state.throttle, replacement.state.requestedWarp),
    );
    expect([...original.state.rotationRatesRadS]).toEqual([0, 0, 0]);

    bridge.apply(frame);
    expect(replacement.state.rotationRatesRadS[1]).toBe(ROTATION_RATE_RAD_S);
    expect([...original.state.rotationRatesRadS]).toEqual([0, 0, 0]);
  });

  it('zeroes commanded rotation on an explicit release', () => {
    const controller = createCommandController(['earth']);
    const bridge = new InputCommandBridge(controller.commands, () =>
      snapshotOf(controller.state.throttle, controller.state.requestedWarp),
    );
    const frame = new StubFrame();

    frame.axes.roll = -1;
    bridge.apply(frame);
    expect(controller.state.rotationRatesRadS[2]).toBe(-ROTATION_RATE_RAD_S);

    bridge.releaseAxes();
    expect([...controller.state.rotationRatesRadS]).toEqual([0, 0, 0]);
  });
});
