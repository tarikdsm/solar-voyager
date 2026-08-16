/**
 * RCS puffs at `rcs_pod_1..4` (T0122).
 *
 * T0121 gives each pod four bells, so four pods is **sixteen** thrusters — which
 * is exactly the "preallocated sprite pool capped at 16 live" the task asks for.
 * The cap is the hardware, not a magic number, and the pool is one `Points`
 * object with sixteen static vertices and two dynamic attributes: one draw call
 * for the whole set, and no allocation once the table is built.
 *
 * Which bells fire is *solved*, not scripted. Each bell has a fixed model-frame
 * position `r` and exhaust direction `u`; firing it applies `tau = r x (-u)` to
 * the ship. For a commanded body-frame angular velocity `omega` the weight is
 * `max(0, tauHat . omegaHat)`, so bells whose torque opposes the rotation stay
 * dark and the couples a reader expects fall out on their own (design doc §5).
 */

import { BufferAttribute, BufferGeometry, Points, type PointsMaterial, type Texture } from 'three';

import {
  attachAdditivePointAttributes,
  createAdditivePointMaterial,
  disposeAdditivePoints,
  type AdditivePointAttributes,
} from './additivePointSprite.js';
import {
  SHIP_RCS_AXIAL_BELL_OFFSET_M,
  SHIP_RCS_POD_ORIGINS_M,
  SHIP_RCS_TANGENTIAL_BELL_OFFSET_M,
} from './shipEffectAnchors.js';
import { SHIP_MODEL_SCALE_KM_PER_UNIT } from './shipVisual.js';

/** Four pods times four bells. The pool size and the live cap are both this. */
export const RCS_BELL_COUNT = 16;

/** Body-frame rate at which a puff reaches full brightness, rad/s. */
export const RCS_FULL_RATE_RAD_S = 0.12;

/** Below this the rotation is drift, not a command, and nothing fires. */
export const RCS_MIN_RATE_RAD_S = 4e-3;

/**
 * Largest per-frame attitude step whose axis-angle extraction is trusted.
 *
 * `Delta q -> (axis, angle)` aliases past pi. At `maxSlewRadPerSimS = 0.261799`
 * that needs ~12 s of simulated time in one frame, i.e. warp above roughly 700.
 * Beyond this the rates are dropped rather than believed — an RCS strobe at
 * 1000x warp is noise — and `ShipEffects` counts the drops.
 */
export const RCS_MAX_TRUSTED_STEP_RAD = 1;

/** Puff diameter at full rate, in model metres. */
const PUFF_MAX_DIAMETER_M = 1.35;

/** Peak additive brightness of one puff. */
const PUFF_MAX_INTENSITY = 2.2;

/** How far past the bell mouth the puff sprite sits, in model metres. */
const PUFF_STANDOFF_M = 0.22;

/** Cold-gas white with a faint blue cast. */
export const RCS_PUFF_COLOR = 0xd8_e8_ff;

/**
 * Exhaust directions of one pod's four bells, in model axes.
 *
 * `_rcs_pod_mesh()` seats bells on the pod's local `±X` (fore/aft along the
 * hull) and local `±Y` (tangential). The pod frames differ between port and
 * starboard only by the sign of that tangential axis, so the *set* of four
 * model-frame directions is the same for every pod and the ambiguity cannot
 * reach the render.
 */
const BELL_DIRECTIONS: readonly (readonly [number, number, number])[] = Object.freeze([
  Object.freeze([1, 0, 0] as const),
  Object.freeze([-1, 0, 0] as const),
  Object.freeze([0, 1, 0] as const),
  Object.freeze([0, -1, 0] as const),
]);

/** Bell anchor positions in model metres, packed xyz. Built once at import. */
export const RCS_BELL_POSITIONS_M = new Float64Array(RCS_BELL_COUNT * 3);

/** Unit torque axes in **model** axes, packed xyz, aligned with the positions. */
export const RCS_BELL_TORQUE_AXES = new Float64Array(RCS_BELL_COUNT * 3);

function buildBellTable(): void {
  for (let pod = 0; pod < SHIP_RCS_POD_ORIGINS_M.length; pod += 1) {
    const origin = SHIP_RCS_POD_ORIGINS_M[pod];
    if (origin === undefined) throw new Error('RCS pod origin table is sparse.');
    for (let bell = 0; bell < BELL_DIRECTIONS.length; bell += 1) {
      const direction = BELL_DIRECTIONS[bell];
      if (direction === undefined) throw new Error('RCS bell direction table is sparse.');
      const axial = direction[0] !== 0;
      const mouthOffset =
        (axial ? SHIP_RCS_AXIAL_BELL_OFFSET_M : SHIP_RCS_TANGENTIAL_BELL_OFFSET_M) +
        PUFF_STANDOFF_M;
      const index = pod * BELL_DIRECTIONS.length + bell;
      const offset = index * 3;
      const positionX = origin[0] + direction[0] * mouthOffset;
      const positionY = origin[1] + direction[1] * mouthOffset;
      const positionZ = origin[2] + direction[2] * mouthOffset;
      RCS_BELL_POSITIONS_M[offset] = positionX;
      RCS_BELL_POSITIONS_M[offset + 1] = positionY;
      RCS_BELL_POSITIONS_M[offset + 2] = positionZ;
      // Reaction torque of the bell about the ship origin: the pod centre is the
      // lever arm, and the ship is pushed opposite to the exhaust.
      const leverX = origin[0];
      const leverY = origin[1];
      const leverZ = origin[2];
      const forceX = -direction[0];
      const forceY = -direction[1];
      const forceZ = -direction[2];
      const torqueX = leverY * forceZ - leverZ * forceY;
      const torqueY = leverZ * forceX - leverX * forceZ;
      const torqueZ = leverX * forceY - leverY * forceX;
      const length = Math.hypot(torqueX, torqueY, torqueZ);
      if (length === 0) throw new Error('RCS bell produces no torque; the table is wrong.');
      RCS_BELL_TORQUE_AXES[offset] = torqueX / length;
      RCS_BELL_TORQUE_AXES[offset + 1] = torqueY / length;
      RCS_BELL_TORQUE_AXES[offset + 2] = torqueZ / length;
    }
  }
}

buildBellTable();

/**
 * Fills `weights` with each bell's firing strength for one model-frame rate.
 *
 * `w = max(0, tauHat . omegaHat) * saturate(|omega| / RCS_FULL_RATE_RAD_S)`.
 * Returns the number of bells above zero — the live puff count, which can never
 * exceed {@link RCS_BELL_COUNT}.
 */
export function writeRcsWeightsInto(
  weights: Float32Array,
  rateModelX: number,
  rateModelY: number,
  rateModelZ: number,
  liveCap: number,
): number {
  if (weights.length < RCS_BELL_COUNT) {
    throw new RangeError('RCS weight buffer must hold one entry per bell.');
  }
  const cap = Number.isFinite(liveCap) ? Math.max(0, Math.min(RCS_BELL_COUNT, liveCap)) : 0;
  const magnitude = Math.hypot(rateModelX, rateModelY, rateModelZ);
  if (
    cap === 0 ||
    !Number.isFinite(magnitude) ||
    magnitude < RCS_MIN_RATE_RAD_S ||
    magnitude === 0
  ) {
    weights.fill(0, 0, RCS_BELL_COUNT);
    return 0;
  }
  const axisX = rateModelX / magnitude;
  const axisY = rateModelY / magnitude;
  const axisZ = rateModelZ / magnitude;
  const strength = Math.min(1, magnitude / RCS_FULL_RATE_RAD_S);
  let live = 0;
  for (let index = 0; index < RCS_BELL_COUNT; index += 1) {
    const offset = index * 3;
    const alignment =
      (RCS_BELL_TORQUE_AXES[offset] as number) * axisX +
      (RCS_BELL_TORQUE_AXES[offset + 1] as number) * axisY +
      (RCS_BELL_TORQUE_AXES[offset + 2] as number) * axisZ;
    // A tolerance, not zero: half the bells sit exactly on the plane of a pure
    // pitch or yaw and would otherwise flicker on float noise.
    if (alignment <= 1e-6 || live >= cap) {
      weights[index] = 0;
      continue;
    }
    weights[index] = alignment * strength;
    live += 1;
  }
  return live;
}

/** The preallocated puff pool: one `Points`, sixteen bells, one draw call. */
export class RcsVisual {
  readonly points: Points<BufferGeometry, PointsMaterial>;

  private readonly attributes: AdditivePointAttributes;
  private readonly weights = new Float32Array(RCS_BELL_COUNT);
  private liveCap = RCS_BELL_COUNT;
  private livePuffs = 0;

  constructor(spriteTexture: Texture) {
    const positions = new Float32Array(RCS_BELL_COUNT * 3);
    for (let index = 0; index < positions.length; index += 1) {
      positions[index] = RCS_BELL_POSITIONS_M[index] as number;
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    this.attributes = attachAdditivePointAttributes(geometry, RCS_BELL_COUNT);
    this.points = new Points(geometry, createAdditivePointMaterial(spriteTexture, RCS_PUFF_COLOR));
    this.points.frustumCulled = false;
    this.points.matrixAutoUpdate = false;
    this.points.updateMatrix();
    this.points.renderOrder = 2;
    this.points.visible = false;
    // A zero-size point still rasterizes one fragment, so the pool is blanked
    // before the warm-up render rather than relying on `visible` alone.
    this.attributes.sizes.fill(0);
    this.attributes.intensities.fill(0);
    this.attributes.sizeAttribute.needsUpdate = true;
    this.attributes.intensityAttribute.needsUpdate = true;
  }

  /** Publishes one frame's model-frame angular rate. Allocation-free. */
  setRateModel(rateX: number, rateY: number, rateZ: number): void {
    const live = writeRcsWeightsInto(this.weights, rateX, rateY, rateZ, this.liveCap);
    this.livePuffs = live;
    for (let index = 0; index < RCS_BELL_COUNT; index += 1) {
      const weight = this.weights[index] as number;
      this.attributes.sizes[index] = weight * PUFF_MAX_DIAMETER_M * SHIP_MODEL_SCALE_KM_PER_UNIT;
      this.attributes.intensities[index] = weight * PUFF_MAX_INTENSITY;
    }
    this.attributes.sizeAttribute.needsUpdate = true;
    this.attributes.intensityAttribute.needsUpdate = true;
    this.points.visible = live > 0;
  }

  /** The governor's rung: how many bells may be lit at once. */
  setLiveCap(cap: number): void {
    if (!Number.isFinite(cap) || cap < 0) {
      throw new RangeError('RCS live cap must be finite and nonnegative.');
    }
    this.liveCap = Math.min(RCS_BELL_COUNT, Math.floor(cap));
  }

  get livePuffCount(): number {
    return this.livePuffs;
  }

  get liveCapacity(): number {
    return this.liveCap;
  }

  get firing(): boolean {
    return this.points.visible;
  }

  dispose(): void {
    disposeAdditivePoints(this.points);
  }
}
