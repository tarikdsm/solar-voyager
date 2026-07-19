import { Vector2, Vector4, type IUniform } from 'three';

export type ProceduralQuality = 'full' | 'half' | 'minimum';
export type ProceduralSunQuality = ProceduralQuality;

export interface ProceduralSunUniforms extends Record<string, IUniform> {
  readonly uSunEnabled: IUniform<number>;
  readonly uSunOctaves: IUniform<number>;
  readonly uSunSeed: IUniform<Vector2>;
  readonly uSunTimePhases: IUniform<Vector4>;
}

export const SUN_ACTIVITY_CYCLE_SEC = 21_600;
export const SUN_GRANULATION_CYCLE_SEC = 600;

const TWO_PI = Math.PI * 2;

function periodicAngle(timeSec: number, periodSec: number): number {
  const wrapped = ((timeSec % periodSec) + periodSec) % periodSec;
  return (wrapped / periodSec) * TWO_PI;
}

/** Owns stable uniforms for deterministic, warp-aware procedural Sun animation. */
export class ProceduralSunState {
  readonly uniforms: ProceduralSunUniforms;

  constructor(seed: number) {
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
      throw new RangeError('Procedural Sun seed must be a uint32.');
    }
    this.uniforms = {
      uSunEnabled: { value: 1 },
      uSunOctaves: { value: 4 },
      uSunSeed: {
        value: new Vector2((seed & 0xffff) / 0xffff, (seed >>> 16) / 0xffff),
      },
      uSunTimePhases: { value: new Vector4(1, 0, 1, 0) },
    };
  }

  update(simTimeSec: number): void {
    if (!Number.isFinite(simTimeSec)) {
      throw new RangeError('Sun simulation time must be finite.');
    }
    const granulation = periodicAngle(simTimeSec, SUN_GRANULATION_CYCLE_SEC);
    const activity = periodicAngle(simTimeSec, SUN_ACTIVITY_CYCLE_SEC);
    this.uniforms.uSunTimePhases.value.set(
      Math.cos(granulation),
      Math.sin(granulation),
      Math.cos(activity),
      Math.sin(activity),
    );
  }

  setQuality(quality: ProceduralSunQuality): void {
    const octaves = quality === 'full' ? 4 : quality === 'half' ? 2 : quality === 'minimum' ? 1 : 0;
    if (octaves === 0) throw new RangeError('Unknown procedural Sun quality.');
    this.uniforms.uSunOctaves.value = octaves;
  }

  setEnabled(enabled: boolean): void {
    this.uniforms.uSunEnabled.value = enabled ? 1 : 0;
  }
}
