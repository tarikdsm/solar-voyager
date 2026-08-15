import { describe, expect, it, vi } from 'vitest';

import { MANUAL_ATTITUDE_MAX_WARP, type WarpFactor } from '../../core/time.js';
import {
  evaluateBodyRateQuaternionInto,
  quaternionSeparationRad,
} from '../../sim/ship/attitude.js';
import { DEFAULT_VESSEL, type VesselConfig } from '../../sim/ship/vessel.js';
import {
  createCommandController,
  createSimulationSnapshotBuffer,
  type AttitudeMode,
  type Commands,
} from '../../sim/simulationSnapshot.js';
import { createNewGameSimulation } from '../createNewGameSimulation.js';
import {
  FlightController,
  MAX_UPDATE_DT_SEC,
  PURSUIT_DAMPING_PER_S,
  ROTATION_RATE_RAD_S,
} from './flightController.js';

const DEGREE_RAD = Math.PI / 180;
const FRAME_SEC = 1 / 60;

/**
 * A faithful stand-in for the manual-attitude half of `SimulationCore`.
 *
 * physics-spec.md §3.0.1: in manual mode the attitude advances by the commanded
 * body rate held constant over the frame's *simulated* interval,
 * `dtWall * effectiveWarp`, with `Commands.rotate`'s `(pitch, yaw, roll)`
 * reordered to the `[roll, pitch, yaw]` body-axis convention. Driving the
 * controller against this rather than a full core keeps warp and the governor
 * under the test's control.
 */
class FlightRig {
  readonly snapshot = createSimulationSnapshotBuffer(['earth']);
  readonly state;
  readonly commands: Commands;
  readonly rotate;
  readonly setThrottle;
  readonly setAttitudeMode;
  readonly flight: FlightController;
  private readonly angularVelocityBodyRadS = new Float64Array(3);

  constructor(vessel: VesselConfig = DEFAULT_VESSEL) {
    const controller = createCommandController(['earth']);
    this.state = controller.state;
    this.rotate = vi.fn((pitch: number, yaw: number, roll: number) =>
      controller.commands.rotate(pitch, yaw, roll),
    );
    this.setThrottle = vi.fn((fraction: number) => {
      controller.commands.setThrottle(fraction);
    });
    this.setAttitudeMode = vi.fn((mode: AttitudeMode) => {
      controller.commands.setAttitudeMode(mode);
    });
    this.commands = {
      rotate: this.rotate,
      setThrottle: this.setThrottle,
      setAttitudeMode: this.setAttitudeMode,
      setTarget: (bodyId) => {
        controller.commands.setTarget(bodyId);
      },
      setWarp: (warp) => {
        controller.commands.setWarp(warp);
      },
    };
    this.flight = new FlightController({
      commands: this.commands,
      snapshot: () => this.snapshot,
      vessel,
    });
  }

  /** Sets the requested tier and, separately, whatever the governor allowed. */
  setWarp(requestedWarp: WarpFactor, effectiveWarp: WarpFactor = requestedWarp): void {
    this.commands.setWarp(requestedWarp);
    this.snapshot.requestedWarp = requestedWarp;
    this.snapshot.effectiveWarp = effectiveWarp;
  }

  step(wallDtSec: number = FRAME_SEC): void {
    this.flight.update(wallDtSec);
    this.publish(wallDtSec);
  }

  /** Wall-frame body rate the simulation is actually turning at, per body axis. */
  wallRateRadS(commandIndex: number): number {
    return (this.state.rotationRatesRadS[commandIndex] as number) * this.snapshot.effectiveWarp;
  }

  private publish(wallDtSec: number): void {
    this.snapshot.throttle = this.state.throttle;
    this.snapshot.attitudeMode = this.state.attitudeMode;
    if (this.state.attitudeMode !== 'manual') return;
    const omega = this.angularVelocityBodyRadS;
    omega[0] = this.state.rotationRatesRadS[2] as number;
    omega[1] = this.state.rotationRatesRadS[0] as number;
    omega[2] = this.state.rotationRatesRadS[1] as number;
    evaluateBodyRateQuaternionInto(
      this.snapshot.attitudeQuaternion,
      this.snapshot.attitudeQuaternion,
      omega,
      wallDtSec * this.snapshot.effectiveWarp,
    );
  }
}

/** Attitude a pure yaw-right look of `yawRad` from level flight asks for. */
function yawTargetQuaternion(yawRad: number): Float64Array {
  const target = new Float64Array([0, 0, 0, 1]);
  return evaluateBodyRateQuaternionInto(target, target, new Float64Array([0, 0, -yawRad]), 1);
}

interface PursuitTrace {
  readonly settleSec: number | null;
  readonly finalSeparationRad: number;
  readonly maximumReboundRad: number;
  readonly peakRateRadS: number;
}

function tracePursuit(
  rig: FlightRig,
  targetQuaternion: Float64Array,
  frames: number,
): PursuitTrace {
  let previousSeparationRad = quaternionSeparationRad(
    rig.snapshot.attitudeQuaternion,
    targetQuaternion,
  );
  let settleSec: number | null = null;
  let maximumReboundRad = 0;
  let peakRateRadS = 0;
  for (let frame = 1; frame <= frames; frame += 1) {
    rig.step();
    const separationRad = quaternionSeparationRad(
      rig.snapshot.attitudeQuaternion,
      targetQuaternion,
    );
    const rebound = separationRad - previousSeparationRad;
    if (rebound > maximumReboundRad) maximumReboundRad = rebound;
    peakRateRadS = Math.max(peakRateRadS, Math.abs(rig.wallRateRadS(1)));
    previousSeparationRad = separationRad;
    if (settleSec === null && separationRad <= 2 * DEGREE_RAD) settleSec = frame * FRAME_SEC;
  }
  return {
    settleSec,
    finalSeparationRad: previousSeparationRad,
    maximumReboundRad,
    peakRateRadS,
  };
}

describe('FlightController mouse-look pursuit', () => {
  it('converges a look step within 2 s at 1x and never overshoots', () => {
    for (const stepDeg of [10, 20, 30]) {
      const rig = new FlightRig();
      const target = yawTargetQuaternion(stepDeg * DEGREE_RAD);
      rig.flight.setLookDelta(stepDeg * DEGREE_RAD, 0);

      const trace = tracePursuit(rig, target, 600);

      expect(trace.settleSec).not.toBeNull();
      expect(trace.settleSec as number).toBeLessThanOrEqual(2);
      // Critical damping: the error is monotone, so overshoot is not merely
      // under the 2 deg acceptance bound, it is identically zero.
      expect(trace.maximumReboundRad).toBeLessThan(1e-12);
      expect(trace.finalSeparationRad).toBeLessThan(1e-3);
    }
  });

  it('never overshoots even when the slew saturates the rate limit', () => {
    for (const stepDeg of [45, 90, 179]) {
      const rig = new FlightRig();
      const target = yawTargetQuaternion(stepDeg * DEGREE_RAD);
      rig.flight.setLookDelta(stepDeg * DEGREE_RAD, 0);

      const trace = tracePursuit(rig, target, 1_200);

      expect(trace.maximumReboundRad).toBeLessThan(1e-12);
      expect(trace.peakRateRadS).toBeLessThanOrEqual(ROTATION_RATE_RAD_S + 1e-15);
      expect(trace.finalSeparationRad).toBeLessThan(1e-3);
    }
  });

  it('stops commanding once settled instead of chasing the asymptote', () => {
    const rig = new FlightRig();
    rig.flight.setLookDelta(10 * DEGREE_RAD, 0);
    for (let frame = 0; frame < 600; frame += 1) rig.step();

    const callsAfterSettling = rig.rotate.mock.calls.length;
    for (let frame = 0; frame < 120; frame += 1) rig.step();

    expect(rig.rotate).toHaveBeenLastCalledWith(0, 0, 0);
    expect(rig.rotate.mock.calls.length).toBe(callsAfterSettling);
  });

  it('pitches the nose up for an upward look and yaws right for a rightward one', () => {
    const rig = new FlightRig();
    rig.flight.setLookDelta(0, 10 * DEGREE_RAD);
    rig.step();
    // Body +Y is left, so nose-up is a negative pitch rate (ADR-025 §4).
    expect(rig.state.rotationRatesRadS[0] as number).toBeLessThan(0);

    const yawRig = new FlightRig();
    yawRig.flight.setLookDelta(10 * DEGREE_RAD, 0);
    yawRig.step();
    // Body +Z is up, so nose-right is a negative yaw rate.
    expect(yawRig.state.rotationRatesRadS[1] as number).toBeLessThan(0);
  });
});

describe('FlightController wall-time authority', () => {
  it('produces the same apparent motion at 1x and 50x for the same look delta', () => {
    const slow = new FlightRig();
    const fast = new FlightRig();
    fast.setWarp(50);
    slow.flight.setLookDelta(30 * DEGREE_RAD, 0);
    fast.flight.setLookDelta(30 * DEGREE_RAD, 0);

    for (let frame = 0; frame < 240; frame += 1) {
      slow.step();
      fast.step();
      expect(fast.wallRateRadS(1)).toBeCloseTo(slow.wallRateRadS(1), 12);
      expect(
        quaternionSeparationRad(slow.snapshot.attitudeQuaternion, fast.snapshot.attitudeQuaternion),
      ).toBeLessThan(1e-11);
    }
    // The sim-frame rate really is warp-scaled; it is the wall frame that matches.
    expect(fast.state.rotationRatesRadS[1] as number).toBeCloseTo(
      (slow.state.rotationRatesRadS[1] as number) / 50,
      15,
    );
  });

  it('saturates in the wall frame, so a large slew is warp-invariant too', () => {
    const slow = new FlightRig();
    const fast = new FlightRig();
    fast.setWarp(50);
    slow.flight.setLookDelta(Math.PI, 0);
    fast.flight.setLookDelta(Math.PI, 0);
    for (let frame = 0; frame < 60; frame += 1) {
      slow.step();
      fast.step();
    }

    // The control law saturates before the plan §3.1 division, so both tiers see
    // the same 0.6 rad/s of wall-frame authority. Clamping only after dividing
    // would have let 50x through at RATE_MAX of *sim* rate, i.e. 30 rad/s wall.
    expect(Math.abs(slow.wallRateRadS(1))).toBeCloseTo(ROTATION_RATE_RAD_S, 12);
    expect(Math.abs(fast.wallRateRadS(1))).toBeCloseTo(ROTATION_RATE_RAD_S, 12);
    expect(Math.abs(fast.state.rotationRatesRadS[1] as number)).toBeCloseTo(
      ROTATION_RATE_RAD_S / 50,
      12,
    );
  });

  it('scales a held axis by the effective warp the governor actually granted', () => {
    const rig = new FlightRig();
    rig.setWarp(100, 10);
    rig.flight.setRotationAxes(1, 0, 0);
    rig.step();

    // Divides by effectiveWarp (10), not by the requested 100: the wall-clock
    // rate follows the clock that is actually advancing.
    expect(rig.state.rotationRatesRadS[0] as number).toBeCloseTo(ROTATION_RATE_RAD_S / 10, 15);
    expect(rig.wallRateRadS(0)).toBeCloseTo(ROTATION_RATE_RAD_S, 12);
  });
});

describe('FlightController manual-rotation lockout', () => {
  it('refuses manual rotation above the lockout tier while holds still reach the sim', () => {
    const rig = new FlightRig();
    rig.setWarp(1_000, 10);
    rig.flight.setRotationAxes(1, 0, 1);
    rig.flight.setLookDelta(0.5, 0.5);
    rig.step();

    // The governor clamped 1000x down to 10x, but `Commands.rotate` keys its
    // lockout on requestedWarp (ADR-035 handoff), so the controller must too --
    // otherwise it would command rates the sim silently discards.
    expect([...rig.state.rotationRatesRadS]).toEqual([0, 0, 0]);

    rig.flight.requestHold('prograde');
    expect(rig.state.attitudeMode).toBe('prograde');
  });

  it('still rotates exactly at the lockout tier and drops nothing once warp falls back', () => {
    const rig = new FlightRig();
    rig.setWarp(MANUAL_ATTITUDE_MAX_WARP);
    rig.flight.setRotationAxes(1, 0, 0);
    rig.step();
    expect(rig.state.rotationRatesRadS[0] as number).toBeCloseTo(
      ROTATION_RATE_RAD_S / MANUAL_ATTITUDE_MAX_WARP,
      15,
    );

    rig.setWarp(1_000, 1_000);
    rig.step();
    expect([...rig.state.rotationRatesRadS]).toEqual([0, 0, 0]);

    rig.setWarp(1);
    rig.step();
    expect(rig.state.rotationRatesRadS[0] as number).toBe(ROTATION_RATE_RAD_S);
  });

  it('does not accumulate look error while the lockout is engaged', () => {
    const rig = new FlightRig();
    rig.setWarp(1_000);
    for (let frame = 0; frame < 60; frame += 1) {
      rig.flight.setLookDelta(0.2, 0);
      rig.step();
    }
    rig.setWarp(1);
    rig.step();

    // A whole second of suppressed sweeping must not be released as a lurch.
    expect([...rig.state.rotationRatesRadS]).toEqual([0, 0, 0]);
  });
});

describe('FlightController throttle regimes', () => {
  it('caps manual throttle at the vessel manual acceleration exactly', () => {
    const rig = new FlightRig();
    rig.flight.setThrottleAxis(1);
    rig.step();

    const fraction = rig.state.throttle;
    expect(fraction).toBeLessThan(1);
    expect(fraction * DEFAULT_VESSEL.alphaMaxMS2).toBe(DEFAULT_VESSEL.alphaManualMaxMS2);
  });

  it('opens the full envelope in the cruise regime', () => {
    const rig = new FlightRig();
    rig.flight.setThrustRegime('cruise');
    rig.flight.setThrottleAxis(1);
    rig.step();

    expect(rig.state.throttle).toBe(1);
    expect(rig.flight.accelerationCapMS2).toBe(DEFAULT_VESSEL.alphaMaxMS2);
    rig.flight.setThrustRegime('manual');
    rig.step();
    expect(rig.state.throttle * DEFAULT_VESSEL.alphaMaxMS2).toBe(DEFAULT_VESSEL.alphaManualMaxMS2);
  });

  it('reads the ceiling from the session vessel, never from DEFAULT_VESSEL', () => {
    const vessel: VesselConfig = {
      restMassKg: 25_000,
      alphaMaxMS2: 50,
      alphaManualMaxMS2: 5,
      maxSlewRadPerSimS: 0.3,
    };
    const rig = new FlightRig(vessel);
    rig.flight.setThrottleAxis(1);
    rig.step();

    expect(rig.state.throttle).toBeCloseTo(0.1, 15);
    expect(rig.state.throttle * vessel.alphaMaxMS2).toBe(vessel.alphaManualMaxMS2);

    rig.flight.setVessel(DEFAULT_VESSEL);
    rig.step();
    expect(rig.state.throttle * DEFAULT_VESSEL.alphaMaxMS2).toBe(DEFAULT_VESSEL.alphaManualMaxMS2);
  });

  it('ramps the lever with stepThrottle and re-seeds it from a restored throttle', () => {
    const rig = new FlightRig();
    rig.flight.stepThrottle(0.5);
    expect(rig.flight.throttleAxis).toBe(0.5);
    rig.flight.stepThrottle(0.75);
    expect(rig.flight.throttleAxis).toBe(1);

    rig.step();
    // A restore hands back the regime-scaled figure; adopting it must not scale twice.
    expect(rig.flight.adoptCommandedThrottle(rig.state.throttle)).toBe(1);
  });

  it('re-commands the lever once warp drops back below the thrust ceiling', () => {
    const rig = new FlightRig();
    rig.flight.setThrottleAxis(1);
    rig.step();
    const manualFraction = rig.state.throttle;
    expect(manualFraction).toBeGreaterThan(0);

    rig.setWarp(10_000);
    rig.snapshot.throttle = rig.state.throttle;
    expect(rig.state.throttle).toBe(0);
    rig.step();
    expect(rig.state.throttle).toBe(0);

    rig.setWarp(1);
    rig.step();
    expect(rig.state.throttle).toBe(manualFraction);
  });
});

describe('FlightController holds and assists', () => {
  const holds: readonly AttitudeMode[] = [
    'prograde',
    'retrograde',
    'normal',
    'antinormal',
    'radialOut',
    'radialIn',
    'target',
    'manual',
  ];

  it('reaches all eight attitude modes', () => {
    const rig = new FlightRig();
    for (const mode of holds) {
      rig.flight.requestHold(mode);
      expect(rig.state.attitudeMode).toBe(mode);
    }
  });

  it('leaves the attitude to the simulation while a hold is engaged', () => {
    const rig = new FlightRig();
    rig.flight.requestHold('prograde');
    rig.rotate.mockClear();
    for (let frame = 0; frame < 30; frame += 1) rig.step();

    expect(rig.rotate).not.toHaveBeenCalled();
    expect(rig.state.attitudeMode).toBe('prograde');
  });

  it('hands the ship back to the player as soon as the controls are touched', () => {
    const rig = new FlightRig();
    rig.flight.requestHold('retrograde');
    rig.step();
    expect(rig.state.attitudeMode).toBe('retrograde');

    rig.flight.setLookDelta(5 * DEGREE_RAD, 0);
    rig.step();

    expect(rig.state.attitudeMode).toBe('manual');
    expect(rig.state.rotationRatesRadS[1] as number).not.toBe(0);
  });

  it('damps to rest with the assist on and coasts with it off', () => {
    const assisted = new FlightRig();
    assisted.flight.setLookDelta(20 * DEGREE_RAD, 0);
    for (let frame = 0; frame < 600; frame += 1) assisted.step();
    expect([...assisted.state.rotationRatesRadS]).toEqual([0, 0, 0]);

    const coasting = new FlightRig();
    coasting.flight.toggleStabilityAssist();
    expect(coasting.flight.stabilityAssist).toBe(false);
    coasting.flight.setLookDelta(20 * DEGREE_RAD, 0);
    coasting.step();
    const coastRateRadS = coasting.state.rotationRatesRadS[1] as number;
    expect(coastRateRadS).not.toBe(0);
    for (let frame = 0; frame < 600; frame += 1) coasting.step();
    expect(coasting.state.rotationRatesRadS[1] as number).toBe(coastRateRadS);

    coasting.flight.killRotation();
    expect([...coasting.state.rotationRatesRadS]).toEqual([0, 0, 0]);
  });

  it('restores the assist idempotently from a persisted preference', () => {
    const rig = new FlightRig();
    rig.flight.setStabilityAssist(false);
    rig.flight.setStabilityAssist(false);
    expect(rig.flight.stabilityAssist).toBe(false);
    rig.flight.setStabilityAssist(true);
    expect(rig.flight.stabilityAssist).toBe(true);
    expect(rig.flight.thrustRegime).toBe('manual');
    rig.flight.setThrustRegime('cruise');
    expect(rig.flight.thrustRegime).toBe('cruise');
  });

  it('carries an unassisted coast through a warp change as physical momentum', () => {
    // A PARTIAL deflection on purpose. At full deflection the stale wall-frame
    // belief (0.6) and the recomputed-then-clamped one (clamp(0.6*50) = 0.6) are
    // the same number, so the test would pass against the pre-fix code; at 10%
    // they are 0.06 and 0.6, a factor of ten.
    const COAST_AXIS = 0.1;
    const coastWallRateRadS = COAST_AXIS * ROTATION_RATE_RAD_S;
    const rig = new FlightRig();
    rig.flight.setStabilityAssist(false);
    rig.flight.setRotationAxes(0, 0, COAST_AXIS);
    rig.step();
    const coastSimRateRadS = rig.state.rotationRatesRadS[2] as number;
    expect(coastSimRateRadS).toBeCloseTo(coastWallRateRadS, 15);
    rig.flight.setRotationAxes(0, 0, 0);
    rig.step();

    rig.setWarp(50);
    for (let frame = 0; frame < 60; frame += 1) rig.step();

    // Angular momentum is physical: only *commanded* input is warp-normalized
    // (physics-spec.md §3.0.1), so the SIM-frame rate is untouched by the tier
    // change and the ship genuinely appears to spin 50x faster, the way every
    // other motion does under time compression.
    expect(rig.state.rotationRatesRadS[2] as number).toBe(coastSimRateRadS);
    expect(rig.wallRateRadS(2)).toBeCloseTo(coastWallRateRadS * 50, 9);

    // The regression this pins: the controller's model of that rate must be
    // re-derived at the tier in force, not carried over from the tier the coast
    // began on. The ship is turning at 3.0 rad/s of wall rotation, five times its
    // authority, so the first re-engaged command must be the saturated 0.6
    // (less one damping step) — a stale model would command a tenth of that.
    rig.flight.setLookDelta(0.001, 0);
    rig.step();
    const recoveredWallRateRadS = Math.abs(rig.wallRateRadS(2));
    const stalePreFixWallRateRadS = coastWallRateRadS * (1 - PURSUIT_DAMPING_PER_S / 60);
    expect(recoveredWallRateRadS).toBeGreaterThan(0.5);
    expect(recoveredWallRateRadS).toBeGreaterThan(stalePreFixWallRateRadS * 5);
    // Still inside the envelope, and still opposing the coast rather than adding.
    expect(recoveredWallRateRadS).toBeLessThanOrEqual(ROTATION_RATE_RAD_S + 1e-15);
    expect(Math.abs(rig.state.rotationRatesRadS[2] as number)).toBeLessThan(
      Math.abs(coastSimRateRadS),
    );

    rig.flight.killRotation();
    expect([...rig.state.rotationRatesRadS]).toEqual([0, 0, 0]);
  });

  it('clears an unassisted coast when warp crosses the manual lockout', () => {
    const rig = new FlightRig();
    rig.flight.setStabilityAssist(false);
    rig.flight.setRotationAxes(0, 0, 1);
    rig.step();
    rig.flight.setRotationAxes(0, 0, 0);
    rig.step();
    expect(rig.state.rotationRatesRadS[2] as number).toBe(ROTATION_RATE_RAD_S);

    // ADR-035 §6: `setWarp` above MANUAL_ATTITUDE_MAX_WARP clears rates already
    // commanded, so the coast cannot become an unbounded high-warp tumble.
    rig.setWarp(1_000);
    rig.step();

    expect([...rig.state.rotationRatesRadS]).toEqual([0, 0, 0]);
  });

  it('stops a restored spin on demand even though it never commanded it', () => {
    const rig = new FlightRig();
    rig.commands.rotate(0.1, 0.2, 0.3);
    rig.flight.resetAxes();

    rig.flight.killRotation();

    expect([...rig.state.rotationRatesRadS]).toEqual([0, 0, 0]);
  });
});

describe('FlightController flush discipline', () => {
  it('issues nothing at all for an idle frame', () => {
    const rig = new FlightRig();
    rig.step();
    rig.step();

    expect(rig.rotate).not.toHaveBeenCalled();
    expect(rig.setThrottle).not.toHaveBeenCalled();
    expect(rig.setAttitudeMode).not.toHaveBeenCalled();
  });

  it('preserves restored rotation rates until the player moves an axis', () => {
    const rig = new FlightRig();
    rig.commands.rotate(0.1, 0.2, 0.3);
    rig.flight.resetAxes();
    rig.rotate.mockClear();

    rig.step();
    expect(rig.rotate).not.toHaveBeenCalled();
    expect([...rig.state.rotationRatesRadS]).toEqual([0.1, 0.2, 0.3]);

    rig.flight.setRotationAxes(1, 0, 0);
    rig.step();
    expect([...rig.state.rotationRatesRadS]).toEqual([ROTATION_RATE_RAD_S, 0, 0]);
  });

  it('commands exactly zero when a held axis is released', () => {
    const rig = new FlightRig();
    rig.flight.setRotationAxes(1, -1, 1);
    rig.step();
    expect(rig.rotate).toHaveBeenLastCalledWith(
      ROTATION_RATE_RAD_S,
      -ROTATION_RATE_RAD_S,
      ROTATION_RATE_RAD_S,
    );

    rig.flight.setRotationAxes(0, 0, 0);
    rig.step();
    expect(rig.rotate).toHaveBeenLastCalledWith(0, 0, 0);
    expect([...rig.state.rotationRatesRadS]).toEqual([0, 0, 0]);
  });

  it('zeroes the simulation on an explicit release', () => {
    const rig = new FlightRig();
    rig.commands.rotate(0, 0, -ROTATION_RATE_RAD_S);

    rig.flight.releaseAxes();

    expect([...rig.state.rotationRatesRadS]).toEqual([0, 0, 0]);
  });

  it('keeps critical damping at the slowest frame the telemetry clamp allows', () => {
    // `render/telemetry.ts` clamps the game delta to MAX_GAME_DELTA_SEC = 0.1 s,
    // the same figure as MAX_UPDATE_DT_SEC, so this is the worst frame the
    // production loop can ever hand the controller.
    const rig = new FlightRig();
    const target = yawTargetQuaternion(30 * DEGREE_RAD);
    rig.flight.setLookDelta(30 * DEGREE_RAD, 0);

    let previousSeparationRad = quaternionSeparationRad(rig.snapshot.attitudeQuaternion, target);
    let maximumReboundRad = 0;
    for (let frame = 0; frame < 100; frame += 1) {
      rig.step(MAX_UPDATE_DT_SEC);
      const separationRad = quaternionSeparationRad(rig.snapshot.attitudeQuaternion, target);
      maximumReboundRad = Math.max(maximumReboundRad, separationRad - previousSeparationRad);
      previousSeparationRad = separationRad;
    }

    expect(maximumReboundRad).toBeLessThan(1e-12);
    expect(previousSeparationRad).toBeLessThan(1e-3);
  });

  it('clamps a frame longer than production can produce instead of diverging', () => {
    // 2.5 s frames cannot reach the controller — telemetry clamps first — so this
    // pins graceful degradation, not tracking: the integrator must stay bounded
    // and inside the rate envelope. Tracking quality is asserted at 0.1 s above.
    const rig = new FlightRig();
    rig.flight.setLookDelta(30 * DEGREE_RAD, 0);
    for (let frame = 0; frame < 40; frame += 1) rig.step(2.5);

    for (let index = 0; index < 3; index += 1) {
      const rateRadS = rig.state.rotationRatesRadS[index] as number;
      expect(Number.isFinite(rateRadS)).toBe(true);
      expect(Math.abs(rateRadS)).toBeLessThanOrEqual(ROTATION_RATE_RAD_S + 1e-15);
    }
  });
});

describe('FlightController against a live SimulationCore', () => {
  it('commands exactly the manual acceleration ceiling at full throttle', () => {
    const simulation = createNewGameSimulation(DEFAULT_VESSEL);
    const flight = new FlightController({
      commands: simulation.commands,
      snapshot: () => simulation.snapshot,
      vessel: simulation.vessel,
    });

    flight.setThrottleAxis(1);
    flight.update(FRAME_SEC);
    const snapshot = simulation.step(FRAME_SEC);
    const properAccelerationMS2 =
      Math.hypot(
        snapshot.shipProperAccelerationKmS2[0] as number,
        snapshot.shipProperAccelerationKmS2[1] as number,
        snapshot.shipProperAccelerationKmS2[2] as number,
      ) * 1_000;

    expect(properAccelerationMS2).toBeCloseTo(DEFAULT_VESSEL.alphaManualMaxMS2, 9);
    expect(properAccelerationMS2).toBeLessThan(DEFAULT_VESSEL.alphaMaxMS2);
  });

  it('turns through the same wall-clock angle at 1x and 50x under identical mouse input', () => {
    const flownRad: number[] = [];
    for (const warp of [1, 50] as const) {
      const simulation = createNewGameSimulation(DEFAULT_VESSEL);
      const flight = new FlightController({
        commands: simulation.commands,
        snapshot: () => simulation.snapshot,
        vessel: simulation.vessel,
      });
      simulation.commands.setWarp(warp);
      // The controller can only ever read the *published* effective warp, so a
      // tier change is one frame stale by construction. Settle it before
      // measuring; the claim under test is steady-state authority, not the
      // transition.
      let snapshot = simulation.snapshot;
      for (let frame = 0; frame < 30; frame += 1) {
        flight.update(FRAME_SEC);
        snapshot = simulation.step(FRAME_SEC);
      }
      const start = new Float64Array(snapshot.attitudeQuaternion);
      for (let frame = 0; frame < 180; frame += 1) {
        if (frame < 10) flight.setLookDelta(2 * DEGREE_RAD, 0);
        flight.update(FRAME_SEC);
        snapshot = simulation.step(FRAME_SEC);
      }
      expect(snapshot.effectiveWarp).toBeLessThanOrEqual(warp);
      flownRad.push(quaternionSeparationRad(start, snapshot.attitudeQuaternion));
    }

    const [slowRad, fastRad] = flownRad;
    // 3 s of wall time and the same 20 deg of mouse travel: the ship must have
    // turned through the same angle whether the clock ran 1x or 50x.
    expect(slowRad as number).toBeGreaterThan(19 * DEGREE_RAD);
    expect(fastRad as number).toBeCloseTo(slowRad as number, 6);
  });
});
