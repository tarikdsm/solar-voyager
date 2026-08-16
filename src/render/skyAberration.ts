import { Vector3 } from 'three';

import type { RelativisticVisualState } from './relativisticVisualState.js';

/**
 * The one observer-aberration implementation every sky visual shares.
 *
 * physics-spec.md §6.1. The starfield draws the real catalog stars and the Milky
 * Way sky draws the diffuse background behind them. If those two ever computed
 * aberration from different source, a high-beta view would shear the panorama
 * against its own stars and the relativistic model would stop being coherent —
 * so both include this exact string rather than two copies of the same algebra.
 */
export const SKY_ABERRATION_GLSL = /* glsl */ `
  uniform vec3 uObserverBeta;
  uniform float uObserverGamma;
  uniform float uRelativisticActivation;

  vec3 aberrateDirection(vec3 direction) {
    float betaSquared = dot(uObserverBeta, uObserverBeta);
    if (uRelativisticActivation == 0.0 || betaSquared == 0.0) return direction;

    // physics-spec.md section 6.1: observer-frame source direction.
    float betaDotDirection = dot(uObserverBeta, direction);
    float boostCoefficient =
      ((uObserverGamma - 1.0) / betaSquared) * betaDotDirection + uObserverGamma;
    vec3 observedDirection =
      (direction + boostCoefficient * uObserverBeta) /
      (uObserverGamma * (1.0 + betaDotDirection));
    return normalize(mix(direction, observedDirection, uRelativisticActivation));
  }
`;

/** Uniform block matching {@link SKY_ABERRATION_GLSL}; one per sky material. */
export interface SkyAberrationUniforms {
  readonly uObserverBeta: { value: Vector3 };
  readonly uObserverGamma: { value: number };
  readonly uRelativisticActivation: { value: number };
}

/** Builds the setup-time uniform block the shared chunk reads. */
export function createSkyAberrationUniforms(): SkyAberrationUniforms {
  return {
    uObserverBeta: { value: new Vector3() },
    uObserverGamma: { value: 1 },
    uRelativisticActivation: { value: 0 },
  };
}

/** Copies one observer state into a material's aberration uniforms, allocation-free. */
export function writeSkyAberrationUniforms(
  uniforms: Record<string, { value: unknown }>,
  state: Readonly<RelativisticVisualState>,
): void {
  const beta = uniforms.uObserverBeta?.value as Vector3 | undefined;
  if (beta !== undefined) beta.set(state.betaX, state.betaY, state.betaZ);
  if (uniforms.uObserverGamma !== undefined) uniforms.uObserverGamma.value = state.gamma;
  if (uniforms.uRelativisticActivation !== undefined) {
    uniforms.uRelativisticActivation.value = state.activation;
  }
}
