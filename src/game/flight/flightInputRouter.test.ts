import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_VESSEL } from '../../sim/ship/vessel.js';
import {
  createCommandController,
  createSimulationSnapshotBuffer,
  type AttitudeMode,
} from '../../sim/simulationSnapshot.js';
import type { InputAction, InputFrame } from '../input/inputEngine.js';
import { FlightController, ROTATION_RATE_RAD_S } from './flightController.js';
import { FlightInputRouter } from './flightInputRouter.js';

class StubFrame implements InputFrame {
  lookYawRad = 0;
  lookPitchRad = 0;
  readonly axes = { pitch: 0, yaw: 0, roll: 0, throttle: 0 };
  private readonly presses = new Map<InputAction, number>();

  press(action: InputAction, count = 1): this {
    this.presses.set(action, count);
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

function createRig() {
  const snapshot = createSimulationSnapshotBuffer(['earth']);
  const controller = createCommandController(['earth']);
  const ports = {
    commands: controller.commands,
    snapshot: () => snapshot,
    vessel: DEFAULT_VESSEL,
  };
  const flight = new FlightController(ports);
  const router = new FlightInputRouter(flight, ports);
  return {
    flight,
    router,
    snapshot,
    state: controller.state,
    /** One frame: route the polled intent, update, then publish what the sim now holds. */
    step(frame: InputFrame): void {
      router.apply(frame);
      flight.update(1 / 60);
      snapshot.throttle = controller.state.throttle;
      snapshot.attitudeMode = controller.state.attitudeMode;
      snapshot.requestedWarp = controller.state.requestedWarp;
      snapshot.effectiveWarp = controller.state.requestedWarp;
    },
  };
}

describe('FlightInputRouter', () => {
  it('routes axes, look and the analog lever into the controller', () => {
    const rig = createRig();
    const frame = new StubFrame();
    frame.axes.pitch = 1;
    frame.axes.yaw = -1;
    frame.axes.roll = 1;
    frame.axes.throttle = 0.5;
    frame.lookYawRad = 0.01;

    rig.step(frame);

    expect(rig.state.rotationRatesRadS[0] as number).toBe(ROTATION_RATE_RAD_S);
    expect(rig.state.rotationRatesRadS[2] as number).toBe(ROTATION_RATE_RAD_S);
    // Yaw carries the axis feed-forward plus the pursuit of the look delta.
    expect(rig.state.rotationRatesRadS[1] as number).toBeLessThan(-ROTATION_RATE_RAD_S + 1e-9);
    expect(rig.flight.throttleAxis).toBe(0.5);
    expect(rig.state.throttle).toBeCloseTo(
      0.5 * (DEFAULT_VESSEL.alphaManualMaxMS2 / DEFAULT_VESSEL.alphaMaxMS2),
      15,
    );
  });

  it('never touches the simulation for an idle frame', () => {
    const snapshot = createSimulationSnapshotBuffer(['earth']);
    const commands = {
      rotate: vi.fn(),
      setAttitudeMode: vi.fn(),
      setTarget: vi.fn(),
      setThrottle: vi.fn(),
      setWarp: vi.fn(),
    };
    const ports = { commands, snapshot: () => snapshot, vessel: DEFAULT_VESSEL };
    const flight = new FlightController(ports);
    const router = new FlightInputRouter(flight, ports);

    router.apply(new StubFrame());
    flight.update(1 / 60);

    expect(commands.rotate).not.toHaveBeenCalled();
    expect(commands.setThrottle).not.toHaveBeenCalled();
    expect(commands.setWarp).not.toHaveBeenCalled();
    expect(commands.setAttitudeMode).not.toHaveBeenCalled();
  });

  it('walks the warp ladder once per press, including two presses in one frame', () => {
    const rig = createRig();

    rig.step(new StubFrame().press('warpIncrease'));
    expect(rig.state.requestedWarp).toBe(5);

    rig.step(new StubFrame().press('warpIncrease', 2));
    expect(rig.state.requestedWarp).toBe(50);

    rig.step(new StubFrame().press('warpDecrease', 3));
    expect(rig.state.requestedWarp).toBe(1);

    rig.step(new StubFrame().press('warpDecrease'));
    expect(rig.state.requestedWarp).toBe(1);
  });

  it('binds all eight attitude modes on their press edge', () => {
    const bindings: readonly (readonly [InputAction, AttitudeMode])[] = [
      ['attitudePrograde', 'prograde'],
      ['attitudeRetrograde', 'retrograde'],
      ['attitudeNormal', 'normal'],
      ['attitudeAntinormal', 'antinormal'],
      ['attitudeRadialOut', 'radialOut'],
      ['attitudeRadialIn', 'radialIn'],
      ['attitudeTarget', 'target'],
      ['attitudeManual', 'manual'],
    ];
    const rig = createRig();

    for (const [action, mode] of bindings) {
      rig.step(new StubFrame().press(action));
      expect(rig.state.attitudeMode).toBe(mode);
    }
  });

  it('binds kill-rotation and the stability-assist toggle', () => {
    const rig = createRig();
    const held = new StubFrame();
    held.axes.roll = 1;
    rig.step(held);
    expect(rig.state.rotationRatesRadS[2] as number).toBe(ROTATION_RATE_RAD_S);

    rig.step(new StubFrame().press('killRotation'));
    expect([...rig.state.rotationRatesRadS]).toEqual([0, 0, 0]);

    expect(rig.flight.stabilityAssist).toBe(true);
    rig.step(new StubFrame().press('stabilityAssistToggle'));
    expect(rig.flight.stabilityAssist).toBe(false);
    rig.step(new StubFrame().press('stabilityAssistToggle'));
    expect(rig.flight.stabilityAssist).toBe(true);
  });

  it('re-points the warp path at a replacement simulation', () => {
    const rig = createRig();
    const replacement = createCommandController(['earth']);
    rig.router.updatePorts({
      commands: replacement.commands,
      snapshot: () => rig.snapshot,
    });

    rig.router.apply(new StubFrame().press('warpIncrease'));

    expect(replacement.state.requestedWarp).toBe(5);
    expect(rig.state.requestedWarp).toBe(1);
  });
});
