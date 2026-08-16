/**
 * The ship's engine and running-light VFX, as one bound scene node (T0122).
 *
 * Owns the photon beam, the nozzle glow, the RCS puff pool and the light blink,
 * and is the single place the frame loop talks to. Everything hangs off one
 * `Object3D` bound through {@link CameraRelativeSpaceScene.bindPackedEffectVisual}
 * — T0129's degrade policy, whose handoff names this task as its first consumer:
 * these transforms are *derived* quantities, so a non-finite one must skip a bind
 * and warn, not kill the frame loop the way a bad ship position rightly does.
 *
 * The root exists from world creation, before `ship.glb` is fetched, so the beam,
 * the glow and the puffs are all in the scene for `createEpochWorld`'s warm-up
 * `compileAsync` pass ({@link prepareCompilationPass}). That is what keeps the
 * first burn from stalling on a shader compile.
 */

import { Object3D, type Material, type Texture } from 'three';

import type { ReadonlyVec3 } from '../core/vec3.js';
import { writeForwardFromQuaternionInto } from '../sim/ship/attitude.js';

import { createRadialSpriteTexture } from './additivePointSprite.js';
import type { EffectBindingTelemetry } from './effectBindingGuard.js';
import type { RenderQualityProfile } from './perfGovernor.js';
import { plumeApparentMagnitude } from './plumeRadiance.js';
import { PlumeVisual } from './plumeVisual.js';
import { RCS_MAX_TRUSTED_STEP_RAD, RcsVisual } from './rcsVisual.js';
import {
  SHIP_ANCHOR_TOLERANCE_M,
  SHIP_NOZZLE_NODE_NAME,
  SHIP_NOZZLE_THROAT_X_M,
  SHIP_RCS_POD_ORIGINS_M,
  SHIP_RCS_POD_NODE_NAMES,
} from './shipEffectAnchors.js';
import { ShipLights } from './shipLights.js';
import { SHIP_MODEL_SCALE_KM_PER_UNIT } from './shipVisual.js';

/** Label the effect binding warns and reports under. */
export const SHIP_EFFECTS_BINDING_LABEL = 'ship-effects';

/** Throttle used only by the warm-up pass, so every program is real. */
const COMPILATION_THROTTLE = 1;

/** Model-frame rate used only by the warm-up pass; lights every bell family. */
const COMPILATION_RATE_RAD_S = 0.5;

/** Minimum simulated step that produces a usable angular rate. */
const MIN_RATE_STEP_SEC = 1e-6;

/**
 * The `CameraRelativeSpaceScene` surface this needs. Declared structurally so
 * the module stays testable without a full scene, and so nothing here can reach
 * for the throwing bind functions by accident.
 */
export interface ShipEffectsScenePort {
  readonly effectBindingTelemetry: EffectBindingTelemetry;
  bindPackedEffectVisual(
    visual: Object3D,
    positionsKm: Float64Array,
    componentOffset: number,
    label: string,
  ): void;
  unbindVisual(visual: Object3D): boolean;
}

/** What `ShipVisual` needs from here: one magnitude, written before its update. */
export interface ShipPointMagnitudeSink {
  setPlumeMagnitude(magnitude: number): void;
  writeRenderQuaternionInto(target: Float64Array): void;
}

export interface ShipEffectsOptions {
  readonly spaceScene: ShipEffectsScenePort;
  readonly shipVisual: ShipPointMagnitudeSink;
  /** Packed float64 positions whose ship triple the root binds to. */
  readonly positionsKm: Float64Array;
  readonly shipIndex: number;
}

export class ShipEffects {
  readonly root = new Object3D();

  private readonly spaceScene: ShipEffectsScenePort;
  private readonly shipVisual: ShipPointMagnitudeSink;
  private readonly positionsKm: Float64Array;
  private readonly positionOffset: number;
  private readonly spriteTexture: Texture;
  private readonly plume: PlumeVisual;
  private readonly rcs: RcsVisual;
  private readonly lights = new ShipLights();

  private readonly renderQuaternion = new Float64Array([0, 0, 0, 1]);
  private readonly previousAttitude = new Float64Array([0, 0, 0, 1]);
  private readonly aftScratch = new Float64Array(3);

  private attitudeSeeded = false;
  private compiling = false;
  private currentThrottle = 0;
  private currentPowerDrawW = 0;
  private currentSimTimeSec = 0;
  private currentCosExhaust = 0;
  private currentPlumeMagnitude = Number.POSITIVE_INFINITY;
  private degradedRateStepCount = 0;
  private modelBoundFlag = false;
  private anchorErrorMeters = Number.NaN;
  private rateModelX = 0;
  private rateModelY = 0;
  private rateModelZ = 0;

  constructor(options: ShipEffectsOptions) {
    const { positionsKm, shipIndex } = options;
    if (!Number.isInteger(shipIndex) || shipIndex < 0 || shipIndex * 3 + 2 >= positionsKm.length) {
      throw new RangeError('Ship effects index must address one packed xyz triple.');
    }
    this.spaceScene = options.spaceScene;
    this.shipVisual = options.shipVisual;
    this.positionsKm = positionsKm;
    this.positionOffset = shipIndex * 3;

    this.spriteTexture = createRadialSpriteTexture();
    this.plume = new PlumeVisual(this.spriteTexture);
    this.rcs = new RcsVisual(this.spriteTexture);

    this.root.scale.setScalar(SHIP_MODEL_SCALE_KM_PER_UNIT);
    this.root.add(this.plume.beam);
    this.root.add(this.plume.glow);
    this.root.add(this.rcs.points);
    this.spaceScene.bindPackedEffectVisual(
      this.root,
      positionsKm,
      this.positionOffset,
      SHIP_EFFECTS_BINDING_LABEL,
    );
  }

  /**
   * Publishes one simulation snapshot's engine state.
   *
   * `simDeltaSec` is the **simulated** step, so the derived rotation rate is in
   * sim rad/s at every warp tier and a paused frame produces no rate at all.
   */
  writeState(
    attitudeQuaternion: Float64Array,
    throttle: number,
    powerDrawW: number,
    simTimeSec: number,
    simDeltaSec: number,
  ): void {
    this.currentThrottle = Number.isFinite(throttle) ? Math.max(0, Math.min(1, throttle)) : 0;
    this.currentPowerDrawW = Number.isFinite(powerDrawW) ? Math.max(0, powerDrawW) : 0;
    this.currentSimTimeSec = Number.isFinite(simTimeSec) ? simTimeSec : this.currentSimTimeSec;

    const x = attitudeQuaternion[0] as number;
    const y = attitudeQuaternion[1] as number;
    const z = attitudeQuaternion[2] as number;
    const w = attitudeQuaternion[3] as number;
    const finiteAttitude =
      Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) && Number.isFinite(w);
    if (finiteAttitude) {
      this.updateRate(x, y, z, w, simDeltaSec);
      this.previousAttitude[0] = x;
      this.previousAttitude[1] = y;
      this.previousAttitude[2] = z;
      this.previousAttitude[3] = w;
      this.attitudeSeeded = true;
    } else {
      this.rateModelX = 0;
      this.rateModelY = 0;
      this.rateModelZ = 0;
    }

    this.shipVisual.writeRenderQuaternionInto(this.renderQuaternion);
    this.root.quaternion.set(
      this.renderQuaternion[0] as number,
      this.renderQuaternion[1] as number,
      this.renderQuaternion[2] as number,
      this.renderQuaternion[3] as number,
    );
    if (this.compiling) return;
    this.plume.setThrottle(this.currentThrottle);
    this.rcs.setRateModel(this.rateModelX, this.rateModelY, this.rateModelZ);
    this.lights.update(this.currentSimTimeSec);
  }

  /**
   * Writes the far-field plume magnitude into the ship's point-cloud slot.
   *
   * Called before `ShipVisual.update`, which is where the two magnitudes are
   * combined in flux. This is the whole "artificial star": no extra object, no
   * second brightness ladder, one number through the path that already exists.
   */
  update(cameraPositionKm: ReadonlyVec3): void {
    const shipX = this.positionsKm[this.positionOffset] as number;
    const shipY = this.positionsKm[this.positionOffset + 1] as number;
    const shipZ = this.positionsKm[this.positionOffset + 2] as number;
    const toCameraX = cameraPositionKm.x - shipX;
    const toCameraY = cameraPositionKm.y - shipY;
    const toCameraZ = cameraPositionKm.z - shipZ;
    const distanceKm = Math.sqrt(
      toCameraX * toCameraX + toCameraY * toCameraY + toCameraZ * toCameraZ,
    );
    let cosExhaust = 0;
    if (distanceKm > 0 && this.attitudeSeeded) {
      writeForwardFromQuaternionInto(this.aftScratch, this.previousAttitude);
      // The exhaust leaves along -forward (ADR-025 makes +X both nose and thrust).
      cosExhaust =
        (-(this.aftScratch[0] as number) * toCameraX -
          (this.aftScratch[1] as number) * toCameraY -
          (this.aftScratch[2] as number) * toCameraZ) /
        distanceKm;
    }
    this.currentCosExhaust = Number.isFinite(cosExhaust) ? cosExhaust : 0;
    this.currentPlumeMagnitude =
      this.currentThrottle > 0
        ? plumeApparentMagnitude(this.currentPowerDrawW, this.currentCosExhaust, distanceKm)
        : Number.POSITIVE_INFINITY;
    this.shipVisual.setPlumeMagnitude(this.currentPlumeMagnitude);
  }

  /**
   * Verifies the transcribed anchors against the loaded asset and adopts lights.
   *
   * `shipEffectAnchors.ts` holds `ship_config.py`'s numbers so the effects can be
   * precompiled before the model exists; this is where that transcription is
   * checked. The worst error is published rather than thrown: a plume 5 cm off is
   * a finding for a browser gate, not a reason to end a session.
   */
  bindModel(modelRoot: Object3D, materials: readonly Material[]): void {
    let worstError = 0;
    const nozzle = modelRoot.getObjectByName(SHIP_NOZZLE_NODE_NAME);
    worstError = Math.max(
      worstError,
      nozzle === undefined
        ? Number.POSITIVE_INFINITY
        : Math.hypot(
            nozzle.position.x - SHIP_NOZZLE_THROAT_X_M,
            nozzle.position.y,
            nozzle.position.z,
          ),
    );
    for (let index = 0; index < SHIP_RCS_POD_NODE_NAMES.length; index += 1) {
      const name = SHIP_RCS_POD_NODE_NAMES[index] as string;
      const expected = SHIP_RCS_POD_ORIGINS_M[index];
      const node = modelRoot.getObjectByName(name);
      if (node === undefined || expected === undefined) {
        worstError = Number.POSITIVE_INFINITY;
        continue;
      }
      worstError = Math.max(
        worstError,
        Math.hypot(
          node.position.x - expected[0],
          node.position.y - expected[1],
          node.position.z - expected[2],
        ),
      );
    }
    this.anchorErrorMeters = worstError;
    this.lights.bind(materials);
    this.lights.update(this.currentSimTimeSec);
    this.modelBoundFlag = true;
  }

  /** Applies a governor rung: beam tessellation and puff pool size. */
  applyQuality(profile: RenderQualityProfile): void {
    this.plume.setBeamSegments(profile.plumeBeamSegments);
    this.rcs.setLiveCap(profile.rcsPuffCap);
  }

  /**
   * Forces every effect visible and lit for the warm-up `compileAsync` + render.
   *
   * Mirrors `TrajectoryOverlay.prepareCompilationPass`: the shaders that a burn
   * needs must be compiled while a loading screen is up, never on the frame the
   * player first touches the throttle. `endCompilationPass` puts it all back.
   */
  prepareCompilationPass(): void {
    this.compiling = true;
    this.plume.setThrottle(COMPILATION_THROTTLE);
    this.rcs.setLiveCap(16);
    this.rcs.setRateModel(COMPILATION_RATE_RAD_S, COMPILATION_RATE_RAD_S, COMPILATION_RATE_RAD_S);
  }

  endCompilationPass(): void {
    this.compiling = false;
    this.plume.setThrottle(this.currentThrottle);
    this.rcs.setRateModel(this.rateModelX, this.rateModelY, this.rateModelZ);
  }

  dispose(): void {
    this.lights.unbind();
    this.spaceScene.unbindVisual(this.root);
    this.plume.dispose();
    this.rcs.dispose();
    this.spriteTexture.dispose();
  }

  get beamLengthM(): number {
    return this.plume.beamLengthM;
  }

  get beamIntensity(): number {
    return this.plume.beamIntensity;
  }

  get beamSegments(): number {
    return this.plume.beamSegments;
  }

  get burning(): boolean {
    return this.plume.burning;
  }

  get throttle(): number {
    return this.currentThrottle;
  }

  get cosExhaustAngle(): number {
    return this.currentCosExhaust;
  }

  get plumeMagnitude(): number {
    return this.currentPlumeMagnitude;
  }

  get rcsFiring(): boolean {
    return this.rcs.firing;
  }

  get rcsLivePuffCount(): number {
    return this.rcs.livePuffCount;
  }

  get rcsLiveCapacity(): number {
    return this.rcs.liveCapacity;
  }

  /** Frames whose attitude step was too large to differentiate (design doc §5). */
  get degradedRateSteps(): number {
    return this.degradedRateStepCount;
  }

  get lightCount(): number {
    return this.lights.boundCount;
  }

  get beaconFactor(): number {
    return this.lights.beaconFactor;
  }

  get navFactor(): number {
    return this.lights.navFactor;
  }

  get modelBound(): boolean {
    return this.modelBoundFlag;
  }

  /** Worst anchor mismatch against the loaded asset, metres; NaN before binding. */
  get anchorErrorM(): number {
    return this.anchorErrorMeters;
  }

  get anchorsVerified(): boolean {
    return this.modelBoundFlag && this.anchorErrorMeters <= SHIP_ANCHOR_TOLERANCE_M;
  }

  /** T0129's flag, surfaced for the first time by a real effect consumer. */
  get nonFiniteObserved(): boolean {
    return this.spaceScene.effectBindingTelemetry.nonFiniteObserved;
  }

  get degradedBindingCount(): number {
    return this.spaceScene.effectBindingTelemetry.degradedBindingCount;
  }

  get skippedBindCount(): number {
    return this.spaceScene.effectBindingTelemetry.skippedBindCount;
  }

  /**
   * Body-frame angular rate from consecutive attitudes, mapped to model axes.
   *
   * `CommandState.rotationRatesRadS` is not used on purpose: it is zero during a
   * hold-mode slew (ADR-035), when the ship is turning hardest, so a
   * command-driven puff would go silent exactly when it matters. Differentiating
   * the attitude covers manual, hold and cruise rotation with one rule and adds
   * no interface (design doc §5).
   */
  private updateRate(x: number, y: number, z: number, w: number, simDeltaSec: number): void {
    if (!this.attitudeSeeded || !Number.isFinite(simDeltaSec) || simDeltaSec <= MIN_RATE_STEP_SEC) {
      this.rateModelX = 0;
      this.rateModelY = 0;
      this.rateModelZ = 0;
      return;
    }
    // delta = conjugate(previous) x current, i.e. the rotation in body axes.
    const px = -(this.previousAttitude[0] as number);
    const py = -(this.previousAttitude[1] as number);
    const pz = -(this.previousAttitude[2] as number);
    const pw = this.previousAttitude[3] as number;
    let deltaX = pw * x + px * w + py * z - pz * y;
    let deltaY = pw * y - px * z + py * w + pz * x;
    let deltaZ = pw * z + px * y - py * x + pz * w;
    let deltaW = pw * w - px * x - py * y - pz * z;
    // Take the short way round, so a sign flip in the snapshot quaternion is not
    // read as a 2*pi rotation.
    if (deltaW < 0) {
      deltaX = -deltaX;
      deltaY = -deltaY;
      deltaZ = -deltaZ;
      deltaW = -deltaW;
    }
    const sine = Math.hypot(deltaX, deltaY, deltaZ);
    if (sine === 0 || !Number.isFinite(sine)) {
      this.rateModelX = 0;
      this.rateModelY = 0;
      this.rateModelZ = 0;
      return;
    }
    const angle = 2 * Math.atan2(sine, deltaW);
    if (angle > RCS_MAX_TRUSTED_STEP_RAD) {
      this.degradedRateStepCount += 1;
      this.rateModelX = 0;
      this.rateModelY = 0;
      this.rateModelZ = 0;
      return;
    }
    const scale = angle / (sine * simDeltaSec);
    const bodyX = deltaX * scale;
    const bodyY = deltaY * scale;
    const bodyZ = deltaZ * scale;
    // Body -> model is the inverse of shipVisual's +90 degrees about X:
    // model = (body.x, body.z, -body.y).
    this.rateModelX = bodyX;
    this.rateModelY = bodyZ;
    this.rateModelZ = -bodyY;
  }
}
