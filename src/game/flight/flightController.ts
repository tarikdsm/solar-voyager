import { MANUAL_ATTITUDE_MAX_WARP } from '../../core/time.js';
import { evaluateBodyRateQuaternionInto } from '../../sim/ship/attitude.js';
import { validateVesselConfig, type VesselConfig } from '../../sim/ship/vessel.js';
import type { AttitudeMode, Commands, SimSnapshot } from '../../sim/simulationSnapshot.js';

/**
 * Manual rotation authority in rad per **wall** second at full deflection.
 *
 * physics-spec.md §3.0.1 calls this `RATE_MAX`. It moved here unchanged from
 * the interim `game/input/inputCommandBridge.ts` that T0108 deletes.
 */
export const ROTATION_RATE_RAD_S = 0.6;

/** Pursuit stiffness in rad/s² per rad of attitude error (T0108 design §3). */
export const PURSUIT_STIFFNESS_PER_S2 = 6;

/**
 * Pursuit damping in 1/s.
 *
 * Written as `2*sqrt(k_p)` rather than a decimal literal so the pair cannot
 * drift into an accidental zeta != 1: this is exactly critical damping, which
 * is what makes the step response monotone and the overshoot identically zero.
 */
export const PURSUIT_DAMPING_PER_S = 2 * Math.sqrt(PURSUIT_STIFFNESS_PER_S2);

/**
 * Largest wall step the pursuit integrates in one call.
 *
 * Explicit integration of the second-order law is stable for `k_d*dt < 2`
 * (0.41 s here); a stalled tab or a debugger pause must not be able to inject a
 * divergent step.
 */
export const MAX_UPDATE_DT_SEC = 0.1;

/** Below this error and rate the pursuit is snapped to rest (design §3). */
const SETTLE_ERROR_RAD = 1e-4;
const SETTLE_RATE_RAD_S = 1e-4;

// Body-axis order, ADR-025 §4: +X forward is roll, +Y is pitch, +Z is yaw.
// Everything in this file is stored in this order and converted to the
// `Commands.rotate(pitch, yaw, roll)` order at exactly one call site.
const AXIS_ROLL = 0;
const AXIS_PITCH = 1;
const AXIS_YAW = 2;

/** Which acceleration ceiling the throttle lever is scaled against. */
export type ThrustRegime = 'manual' | 'cruise';

export interface FlightControllerPorts {
  readonly commands: Commands;
  /** The simulation's currently published snapshot; never retained. */
  snapshot(): SimSnapshot;
  /** The vessel in force for this session — `SimulationCore.vessel`, not `DEFAULT_VESSEL`. */
  readonly vessel: VesselConfig;
}

function clampRate(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value > ROTATION_RATE_RAD_S) return ROTATION_RATE_RAD_S;
  return value < -ROTATION_RATE_RAD_S ? -ROTATION_RATE_RAD_S : value;
}

function clampAxis(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value > 1) return 1;
  return value < -1 ? -1 : value;
}

function clamp01(value: number): number {
  if (value <= 0) return 0;
  return value >= 1 ? 1 : value;
}

/**
 * Turns player intent into `Commands` for a ship that behaves like it has mass.
 *
 * Two control channels, deliberately different (v2 plan §2, design §2):
 * mouse-look deltas are a *position* demand integrated into a desired attitude
 * that a critically damped law pursues; keyboard/gamepad axes are a *rate*
 * demand fed forward directly, with the desired attitude re-anchored to the
 * ship while an axis is deflected so the two never fight.
 *
 * Replaces v1's `KeyboardCommandMapper` and T0105's interim
 * `InputCommandBridge`. `update()` is allocation-free.
 */
export class FlightController {
  private ports: FlightControllerPorts;
  private alphaMaxMS2: number;
  private alphaManualMaxMS2: number;
  private regime: ThrustRegime = 'manual';
  private regimeFraction: number;
  private throttleLever = 0;
  private assistEnabled = true;
  private pendingLookYawRad = 0;
  private pendingLookPitchRad = 0;
  private axisActive = false;
  /** Desired attitude the pursuit chases, `[x,y,z,w]`. */
  private readonly desiredQuaternion = new Float64Array(4);
  /** Pursuit contribution to the body rate, wall frame, body-axis order. */
  private readonly pursuitRateRadS = new Float64Array(3);
  /** Feed-forward from the deflected axes, wall frame, body-axis order. */
  private readonly axisRateRadS = new Float64Array(3);
  /** Total wall-frame body rate last committed; equals what the ship is doing. */
  private readonly commandedRateRadS = new Float64Array(3);
  /** Rotation vector from the published attitude to the desired one, body-axis order. */
  private readonly errorRotationRad = new Float64Array(3);
  /** Scratch for the look-delta composition. */
  private readonly lookRotationRad = new Float64Array(3);
  /** Last triple handed to `Commands.rotate`, in `(pitch, yaw, roll)` order. */
  private readonly issuedRatesRadS = new Float64Array(3);

  constructor(ports: FlightControllerPorts) {
    this.ports = ports;
    const vessel = validateVesselConfig(ports.vessel);
    this.alphaMaxMS2 = vessel.alphaMaxMS2;
    this.alphaManualMaxMS2 = vessel.alphaManualMaxMS2;
    this.regimeFraction = this.alphaManualMaxMS2 / this.alphaMaxMS2;
    this.desiredQuaternion.set(ports.snapshot().attitudeQuaternion);
  }

  /** Lever position in `[0, 1]`, before the regime ceiling is applied. */
  get throttleAxis(): number {
    return this.throttleLever;
  }

  get thrustRegime(): ThrustRegime {
    return this.regime;
  }

  get stabilityAssist(): boolean {
    return this.assistEnabled;
  }

  /** Accumulates pointer-lock deltas for the next `update()`; `+right`, `+up`. */
  setLookDelta(yawRad: number, pitchRad: number): void {
    if (Number.isFinite(yawRad)) this.pendingLookYawRad += yawRad;
    if (Number.isFinite(pitchRad)) this.pendingLookPitchRad += pitchRad;
  }

  /** Sets the direct rate channel from `[-1, 1]` axes. */
  setRotationAxes(pitch: number, yaw: number, roll: number): void {
    const axis = this.axisRateRadS;
    axis[AXIS_PITCH] = clampAxis(pitch) * ROTATION_RATE_RAD_S;
    axis[AXIS_YAW] = clampAxis(yaw) * ROTATION_RATE_RAD_S;
    axis[AXIS_ROLL] = clampAxis(roll) * ROTATION_RATE_RAD_S;
  }

  /** Sets the analog lever absolutely. */
  setThrottleAxis(value01: number): void {
    if (!Number.isFinite(value01)) throw new RangeError('throttle axis must be finite');
    this.throttleLever = clamp01(value01);
  }

  /** Nudges the analog lever; for callers that own the lever themselves. */
  stepThrottle(delta01: number): void {
    if (!Number.isFinite(delta01)) throw new RangeError('throttle step must be finite');
    this.throttleLever = clamp01(this.throttleLever + delta01);
  }

  /**
   * Seeds the lever from a throttle the simulation has already regime-scaled.
   *
   * Restore path: `snapshot.throttle` is `lever * regimeFraction`, so feeding it
   * back in as a lever position would scale it twice. Returns the lever so the
   * input engine, which owns the same lever, can be seeded from one figure.
   */
  adoptCommandedThrottle(commandedFraction01: number): number {
    if (!Number.isFinite(commandedFraction01)) {
      throw new RangeError('commanded throttle must be finite');
    }
    this.throttleLever =
      this.regimeFraction > 0 ? clamp01(commandedFraction01 / this.regimeFraction) : 0;
    return this.throttleLever;
  }

  /** Engages any of the eight attitude modes, `'manual'` included. */
  requestHold(mode: AttitudeMode): void {
    this.ports.commands.setAttitudeMode(mode);
    this.stopRotation();
  }

  /** Stops the ship rotating now, whatever the assist state. */
  killRotation(): void {
    this.stopRotation();
  }

  /** Selects the acceleration ceiling; `'cruise'` opens the full envelope (T0116). */
  setThrustRegime(regime: ThrustRegime): void {
    if (regime === this.regime) return;
    this.regime = regime;
    this.refreshRegimeFraction();
  }

  setStabilityAssist(enabled: boolean): void {
    this.assistEnabled = enabled;
  }

  toggleStabilityAssist(): void {
    this.assistEnabled = !this.assistEnabled;
  }

  /** Re-reads the session vessel after a restore replaced the simulation (ADR-034 §4). */
  setVessel(vessel: VesselConfig): void {
    const validated = validateVesselConfig(vessel);
    this.alphaMaxMS2 = validated.alphaMaxMS2;
    this.alphaManualMaxMS2 = validated.alphaManualMaxMS2;
    this.refreshRegimeFraction();
  }

  /** Proper-acceleration ceiling the lever is currently scaled against, in m/s². */
  get accelerationCapMS2(): number {
    return this.regime === 'cruise' ? this.alphaMaxMS2 : this.alphaManualMaxMS2;
  }

  private refreshRegimeFraction(): void {
    this.regimeFraction = this.accelerationCapMS2 / this.alphaMaxMS2;
  }

  /**
   * Forgets local intent without touching the simulation.
   *
   * The restore path: the restored simulation already carries the saved rotation
   * rates, and commanding the (just released) axes over them would erase them.
   */
  resetAxes(): void {
    this.pendingLookYawRad = 0;
    this.pendingLookPitchRad = 0;
    this.axisActive = false;
    this.pursuitRateRadS.fill(0);
    this.commandedRateRadS.fill(0);
    this.issuedRatesRadS.fill(0);
    this.desiredQuaternion.set(this.ports.snapshot().attitudeQuaternion);
  }

  /** `resetAxes()` plus an explicit stop; used when settings change under the player. */
  releaseAxes(): void {
    this.resetAxes();
    this.writeRotation(0, 0, 0);
  }

  /** Pushes one frame of intent into the simulation. Allocation-free. */
  update(wallDtSec: number): void {
    const dtSec =
      Number.isFinite(wallDtSec) && wallDtSec > 0 ? Math.min(wallDtSec, MAX_UPDATE_DT_SEC) : 0;
    const snapshot = this.ports.snapshot();
    this.applyThrottle(snapshot);
    this.applyAttitude(snapshot, dtSec);
  }

  private applyThrottle(snapshot: SimSnapshot): void {
    // Compared against the simulation rather than a local latch: setThrottle()
    // forces 0 above MAX_THRUST_WARP, so a latch would leave the lever and the
    // sim permanently disagreed instead of resuming when warp drops back.
    const fraction = this.throttleLever * this.regimeFraction;
    if (fraction === snapshot.throttle) return;
    this.ports.commands.setThrottle(fraction);
  }

  private applyAttitude(snapshot: SimSnapshot, dtSec: number): void {
    const lookYawRad = this.pendingLookYawRad;
    const lookPitchRad = this.pendingLookPitchRad;
    this.pendingLookYawRad = 0;
    this.pendingLookPitchRad = 0;
    const hasLook = lookYawRad !== 0 || lookPitchRad !== 0;
    const axis = this.axisRateRadS;
    const hasAxis =
      (axis[AXIS_ROLL] as number) !== 0 ||
      (axis[AXIS_PITCH] as number) !== 0 ||
      (axis[AXIS_YAW] as number) !== 0;

    // ADR-035 handoff: the sim's lockout keys on requestedWarp, so the
    // controller must gate on the same figure or it would command rates that
    // `rotate()` silently discards and its rate model would go stale.
    if (snapshot.requestedWarp > MANUAL_ATTITUDE_MAX_WARP) {
      this.holdSteady(snapshot);
      return;
    }

    let manual = snapshot.attitudeMode === 'manual';
    if (!manual && (hasLook || hasAxis)) {
      // Touching the controls takes the ship back: pointer-lock deltas are
      // exactly zero when the mouse is still and keyboard axes are exactly
      // 0 or +-1, so no deadzone is needed and jitter cannot break a hold.
      this.ports.commands.setAttitudeMode('manual');
      manual = true;
    }
    if (!manual) {
      this.holdSteady(snapshot);
      return;
    }

    // An axis is a rate demand, not a position demand: re-anchor so the pursuit
    // sees no error from it, and re-anchor once more on the release frame so
    // letting go leaves the nose exactly where it is.
    if (hasAxis || this.axisActive) this.desiredQuaternion.set(snapshot.attitudeQuaternion);
    this.axisActive = hasAxis;
    if (hasLook) this.integrateLook(lookYawRad, lookPitchRad);

    if (!this.assistEnabled && !hasLook && !hasAxis) {
      // Unassisted coast: the last commanded rate stays in the simulation. The
      // pursuit adopts it so re-touching the controls damps from the real rate.
      this.pursuitRateRadS.set(this.commandedRateRadS);
      this.desiredQuaternion.set(snapshot.attitudeQuaternion);
      return;
    }

    this.writeAttitudeError(snapshot);
    this.integratePursuit(snapshot, dtSec, hasAxis);
    this.commitRotation(snapshot.effectiveWarp);
  }

  /** Sim owns the attitude (hold engaged, or manual rotation locked out). */
  private holdSteady(snapshot: SimSnapshot): void {
    this.axisActive = false;
    this.pursuitRateRadS.fill(0);
    this.commandedRateRadS.fill(0);
    this.desiredQuaternion.set(snapshot.attitudeQuaternion);
    this.flushRotation(0, 0, 0);
  }

  private stopRotation(): void {
    this.pendingLookYawRad = 0;
    this.pendingLookPitchRad = 0;
    this.axisActive = false;
    this.pursuitRateRadS.fill(0);
    this.commandedRateRadS.fill(0);
    this.desiredQuaternion.set(this.ports.snapshot().attitudeQuaternion);
    this.writeRotation(0, 0, 0);
  }

  /** Rotates the desired attitude in its own body frame by one frame of look. */
  private integrateLook(lookYawRad: number, lookPitchRad: number): void {
    // Zero-roll convention (ADR-025 §4): body +Z is up and +Y is left, so a
    // right-hand turn about +Z swings the nose left and one about +Y swings it
    // down. `InputFrame` reports +right and +up, hence both negations.
    const look = this.lookRotationRad;
    look[AXIS_ROLL] = 0;
    look[AXIS_PITCH] = -lookPitchRad;
    look[AXIS_YAW] = -lookYawRad;
    evaluateBodyRateQuaternionInto(this.desiredQuaternion, this.desiredQuaternion, look, 1);
  }

  /** Body-frame rotation vector taking the published attitude to the desired one. */
  private writeAttitudeError(snapshot: SimSnapshot): void {
    const current = snapshot.attitudeQuaternion;
    const currentX = current[0] as number;
    const currentY = current[1] as number;
    const currentZ = current[2] as number;
    const currentW = current[3] as number;
    const desired = this.desiredQuaternion;
    const desiredX = desired[0] as number;
    const desiredY = desired[1] as number;
    const desiredZ = desired[2] as number;
    const desiredW = desired[3] as number;
    const dot =
      currentX * desiredX + currentY * desiredY + currentZ * desiredZ + currentW * desiredW;
    const sign = dot < 0 ? -1 : 1;
    const relativeX =
      sign *
      (currentW * desiredX - currentX * desiredW - currentY * desiredZ + currentZ * desiredY);
    const relativeY =
      sign *
      (currentW * desiredY + currentX * desiredZ - currentY * desiredW - currentZ * desiredX);
    const relativeZ =
      sign *
      (currentW * desiredZ - currentX * desiredY + currentY * desiredX - currentZ * desiredW);
    const sineHalfSeparation = Math.hypot(relativeX, relativeY, relativeZ);
    const separationRad = 2 * Math.atan2(sineHalfSeparation, sign * dot);
    const scale = sineHalfSeparation === 0 ? 0 : separationRad / sineHalfSeparation;
    const error = this.errorRotationRad;
    error[AXIS_ROLL] = relativeX * scale;
    error[AXIS_PITCH] = relativeY * scale;
    error[AXIS_YAW] = relativeZ * scale;
  }

  private integratePursuit(snapshot: SimSnapshot, dtSec: number, hasAxis: boolean): void {
    const error = this.errorRotationRad;
    const pursuit = this.pursuitRateRadS;
    const axis = this.axisRateRadS;
    const total = this.commandedRateRadS;
    let settled = !hasAxis;
    for (let index = 0; index < 3; index += 1) {
      const errorRad = error[index] as number;
      const rateRadS = pursuit[index] as number;
      const next = clampRate(
        rateRadS + (PURSUIT_STIFFNESS_PER_S2 * errorRad - PURSUIT_DAMPING_PER_S * rateRadS) * dtSec,
      );
      pursuit[index] = next;
      if (Math.abs(errorRad) > SETTLE_ERROR_RAD || Math.abs(next) > SETTLE_RATE_RAD_S) {
        settled = false;
      }
    }
    // Exponential decay never reaches zero, and `rotate()` re-invalidates the
    // trajectory prediction on every change while thrusting. Snap to rest.
    if (settled) {
      pursuit.fill(0);
      this.desiredQuaternion.set(snapshot.attitudeQuaternion);
    }
    for (let index = 0; index < 3; index += 1) {
      const axisRateRadS = axis[index] as number;
      const totalRateRadS = clampRate((pursuit[index] as number) + axisRateRadS);
      total[index] = totalRateRadS;
      // Anti-windup: the pursuit state must equal the rate the ship is really
      // turning at, or a saturated slew overshoots on the way out.
      pursuit[index] = clampRate(totalRateRadS - axisRateRadS);
    }
  }

  private commitRotation(effectiveWarp: number): void {
    // physics-spec.md §3.0.1 — `clamp(inputRateWallRadS / effectiveWarp, +-RATE_MAX)`,
    // applied verbatim. The control law already saturates against RATE_MAX in the
    // wall frame, which is what makes a saturating input warp-invariant; this
    // clamp therefore never binds on the current ladder (effectiveWarp >= 1) and
    // is kept because it is the contract.
    const divisor = Number.isFinite(effectiveWarp) && effectiveWarp > 0 ? effectiveWarp : 1;
    const total = this.commandedRateRadS;
    this.flushRotation(
      clampRate((total[AXIS_PITCH] as number) / divisor),
      clampRate((total[AXIS_YAW] as number) / divisor),
      clampRate((total[AXIS_ROLL] as number) / divisor),
    );
  }

  /**
   * Issues `rotate()` only on change.
   *
   * Not an optimization: `rotate()` overwrites the simulation's rotation rates,
   * so an unconditional flush would erase rates restored from a save, and it
   * would re-invalidate the trajectory prediction every frame of powered flight.
   */
  private flushRotation(pitchRateRadS: number, yawRateRadS: number, rollRateRadS: number): void {
    const issued = this.issuedRatesRadS;
    if (
      pitchRateRadS === (issued[0] as number) &&
      yawRateRadS === (issued[1] as number) &&
      rollRateRadS === (issued[2] as number)
    ) {
      return;
    }
    this.writeRotation(pitchRateRadS, yawRateRadS, rollRateRadS);
  }

  private writeRotation(pitchRateRadS: number, yawRateRadS: number, rollRateRadS: number): void {
    const issued = this.issuedRatesRadS;
    issued[0] = pitchRateRadS;
    issued[1] = yawRateRadS;
    issued[2] = rollRateRadS;
    this.ports.commands.rotate(pitchRateRadS, yawRateRadS, rollRateRadS);
  }
}
