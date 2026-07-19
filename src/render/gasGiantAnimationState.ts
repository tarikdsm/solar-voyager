import { Vector2, Vector4, type IUniform } from 'three';

import type { ProceduralQuality } from './proceduralSunState.js';

export type GasGiantId = 'jupiter' | 'saturn' | 'uranus' | 'neptune';

interface GasGiantConfig {
  readonly baseRotationHours: number;
  readonly bandCount: number;
  readonly phaseOffset: number;
  readonly spot: Vector4;
}

export const GAS_GIANT_CONFIG: Readonly<Record<GasGiantId, GasGiantConfig>> = {
  jupiter: {
    baseRotationHours: 9.9,
    bandCount: 12,
    phaseOffset: 0.17,
    spot: new Vector4(0.374, 0.64, 0.068, 0.046),
  },
  saturn: {
    baseRotationHours: 10.7,
    bandCount: 16,
    phaseOffset: 0.31,
    spot: new Vector4(0, 0, 0, 0),
  },
  uranus: {
    baseRotationHours: 17.2,
    bandCount: 8,
    phaseOffset: 0.53,
    spot: new Vector4(0, 0, 0, 0),
  },
  neptune: {
    baseRotationHours: 16.1,
    bandCount: 10,
    phaseOffset: 0.71,
    spot: new Vector4(0, 0, 0, 0),
  },
};

export interface GasGiantUniforms extends Record<string, IUniform> {
  readonly uGasEnabled: IUniform<number>;
  readonly uGasOctaves: IUniform<number>;
  readonly uGasSeed: IUniform<Vector2>;
  readonly uGasBandPhases: IUniform<Vector4>;
  readonly uGasStormPhase: IUniform<Vector4>;
  readonly uGasSpot: IUniform<Vector4>;
  readonly uGasWarp: IUniform<Vector4>;
}

const BAND_PHASE_MULTIPLIERS = [1, 0.985, 1.012, 0.975] as const;
export const GAS_GIANT_SHEAR_CYCLE_ROTATIONS = 64;
const GREAT_RED_SPOT_PERIOD_SEC = 6 * 24 * 60 * 60;
const STORM_SHIMMER_PERIOD_SEC = 1_800;
const TWO_PI = Math.PI * 2;

export function isGasGiantId(id: string): id is GasGiantId {
  return id === 'jupiter' || id === 'saturn' || id === 'uranus' || id === 'neptune';
}

function wrappedFraction(timeSec: number, periodSec: number): number {
  const wrapped = ((timeSec % periodSec) + periodSec) % periodSec;
  return wrapped / periodSec;
}

function periodicAngle(timeSec: number, periodSec: number): number {
  return wrappedFraction(timeSec, periodSec) * TWO_PI;
}

function wrappedUnit(value: number): number {
  return ((value % 1) + 1) % 1;
}

/** Owns allocation-free, bounded uniforms for one animated gas-giant mosaic. */
export class GasGiantAnimationState {
  readonly uniforms: GasGiantUniforms;
  private readonly baseRotationSec: number;

  constructor(id: GasGiantId, seed: number) {
    if (!isGasGiantId(id)) throw new RangeError('Unknown gas-giant body id.');
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
      throw new RangeError('Gas-giant procedural seed must be a uint32.');
    }
    const config = GAS_GIANT_CONFIG[id];
    this.baseRotationSec = config.baseRotationHours * 3_600;
    this.uniforms = {
      uGasEnabled: { value: 1 },
      uGasOctaves: { value: 4 },
      uGasSeed: {
        value: new Vector2((seed & 0xffff) / 0xffff, (seed >>> 16) / 0xffff),
      },
      uGasBandPhases: { value: new Vector4() },
      uGasStormPhase: { value: new Vector4(1, 0, 1, 0) },
      uGasSpot: { value: config.spot.clone() },
      uGasWarp: { value: new Vector4(0.006, 0.002, config.bandCount, config.phaseOffset) },
    };
  }

  update(simTimeSec: number): void {
    if (!Number.isFinite(simTimeSec)) {
      throw new RangeError('Gas-giant simulation time must be finite.');
    }
    const phases = this.uniforms.uGasBandPhases.value;
    const basePhase = wrappedFraction(simTimeSec, this.baseRotationSec);
    const shearAngle = periodicAngle(
      simTimeSec,
      this.baseRotationSec * GAS_GIANT_SHEAR_CYCLE_ROTATIONS,
    );
    const boundedShear = (Math.sin(shearAngle) * GAS_GIANT_SHEAR_CYCLE_ROTATIONS) / TWO_PI;
    phases.set(
      wrappedUnit(basePhase + (BAND_PHASE_MULTIPLIERS[0] - 1) * boundedShear),
      wrappedUnit(basePhase + (BAND_PHASE_MULTIPLIERS[1] - 1) * boundedShear),
      wrappedUnit(basePhase + (BAND_PHASE_MULTIPLIERS[2] - 1) * boundedShear),
      wrappedUnit(basePhase + (BAND_PHASE_MULTIPLIERS[3] - 1) * boundedShear),
    );
    const spotAngle = periodicAngle(simTimeSec, GREAT_RED_SPOT_PERIOD_SEC);
    const shimmerAngle = periodicAngle(simTimeSec, STORM_SHIMMER_PERIOD_SEC);
    this.uniforms.uGasStormPhase.value.set(
      Math.cos(spotAngle),
      Math.sin(spotAngle),
      Math.cos(shimmerAngle),
      Math.sin(shimmerAngle),
    );
  }

  setQuality(quality: ProceduralQuality): void {
    const octaves = quality === 'full' ? 4 : quality === 'half' ? 2 : quality === 'minimum' ? 1 : 0;
    if (octaves === 0) throw new RangeError('Unknown gas-giant procedural quality.');
    this.uniforms.uGasOctaves.value = octaves;
  }

  setEnabled(enabled: boolean): void {
    this.uniforms.uGasEnabled.value = enabled ? 1 : 0;
  }
}
