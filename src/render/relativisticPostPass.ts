import { Matrix3, type PerspectiveCamera, Vector2, Vector3 } from 'three';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

import type { AdaptivePostPassPort } from './lightingPostPipeline.js';
import type { RelativisticVisualState } from './relativisticVisualState.js';

const vertexShader = /* glsl */ `
  uniform float uAdaptiveUvScale;

  varying vec2 vUv;
  varying vec2 vViewUv;

  void main() {
    vUv = uv * uAdaptiveUvScale;
    vViewUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform vec3 uObserverBetaCamera;
  uniform float uObserverGamma;
  uniform float uRelativisticActivation;
  uniform vec2 uViewScale;

  varying vec2 vUv;
  varying vec2 vViewUv;

  void main() {
    vec4 sourceColor = texture2D(tDiffuse, vUv);
    vec2 viewPlane = (vViewUv * 2.0 - 1.0) * uViewScale;
    vec3 observedViewDirection = normalize(vec3(viewPlane, -1.0));

    // physics-spec.md section 6.1: D from the observed source direction.
    float doppler = 1.0 / (uObserverGamma *
      (1.0 - dot(uObserverBetaCamera, observedViewDirection)));
    float dopplerOctaves = clamp(log2(doppler), -2.0, 2.0);
    vec3 spectralGain = exp2(dopplerOctaves * vec3(-0.20, 0.05, 0.35));
    spectralGain /= dot(spectralGain, vec3(0.2126, 0.7152, 0.0722));
    float beaming = clamp(doppler * doppler * doppler, 0.20, 8.0);
    vec3 shiftedColor = sourceColor.rgb * spectralGain * beaming;

    gl_FragColor = vec4(
      mix(sourceColor.rgb, shiftedColor, uRelativisticActivation),
      sourceColor.a
    );
  }
`;

export interface RelativisticPostPassPort extends AdaptivePostPassPort {
  updateObserver(state: Readonly<RelativisticVisualState>, camera: PerspectiveCamera): void;
}

export class RelativisticPostPass extends ShaderPass implements RelativisticPostPassPort {
  private readonly cameraRotation = new Matrix3();

  constructor() {
    super({
      name: 'SolarVoyagerRelativisticPost',
      uniforms: {
        tDiffuse: { value: null },
        uAdaptiveUvScale: { value: 1 },
        uObserverBetaCamera: { value: new Vector3() },
        uObserverGamma: { value: 1 },
        uRelativisticActivation: { value: 0 },
        uViewScale: { value: new Vector2(1, 1) },
      },
      vertexShader,
      fragmentShader,
    });
    this.material.name = 'SolarVoyagerRelativisticPost';
    this.enabled = false;
  }

  setRenderScale(scale: number): void {
    const uniform = this.material.uniforms.uAdaptiveUvScale;
    if (uniform === undefined) throw new Error('Relativistic UV scale uniform is missing.');
    uniform.value = scale;
  }

  updateObserver(state: Readonly<RelativisticVisualState>, camera: PerspectiveCamera): void {
    const uniforms = this.material.uniforms;
    const betaCamera = uniforms.uObserverBetaCamera?.value as Vector3 | undefined;
    const viewScale = uniforms.uViewScale?.value as Vector2 | undefined;
    if (betaCamera === undefined || viewScale === undefined) {
      throw new Error('Relativistic post uniforms are missing.');
    }

    this.cameraRotation.setFromMatrix4(camera.matrixWorldInverse);
    betaCamera.set(state.betaX, state.betaY, state.betaZ).applyMatrix3(this.cameraRotation);
    const tangentHalfFov = Math.tan((camera.fov * Math.PI) / 360);
    viewScale.set(tangentHalfFov * camera.aspect, tangentHalfFov);
    if (uniforms.uObserverGamma !== undefined) uniforms.uObserverGamma.value = state.gamma;
    if (uniforms.uRelativisticActivation !== undefined) {
      uniforms.uRelativisticActivation.value = state.activation;
    }
    this.enabled = state.activation !== 0;
  }
}
