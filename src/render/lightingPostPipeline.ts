import {
  ACESFilmicToneMapping,
  HalfFloatType,
  type ShaderMaterial,
  Vector2,
  type WebGLRenderTarget,
  type Camera,
  type Scene,
  type WebGLRenderer,
} from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';

import type { AntiAliasingQuality, BloomQuality, RenderQualityProfile } from './perfGovernor.js';

export const BLOOM_THRESHOLD = 1;
export const BLOOM_STRENGTH = 0.15;
export const BLOOM_RADIUS = 0.35;

export interface PostPassPort {
  enabled: boolean;
  setSize(width: number, height: number): void;
  dispose(): void;
}

export interface AdaptivePostPassPort extends PostPassPort {
  setRenderScale(scale: number): void;
}

export interface UnrealBloomPassPort extends PostPassPort {
  threshold: number;
  strength: number;
  radius: number;
  setQualityScale(renderScale: number, bloomScale: number): void;
}

export interface FxaaPassPort extends AdaptivePostPassPort {
  setResolution(width: number, height: number): void;
}

export interface PostComposerPort {
  readonly passes: PostPassPort[];
  readonly readBuffer: {
    readonly width: number;
    readonly height: number;
    readonly texture: { readonly type: number };
  };
  readonly writeBuffer: {
    readonly width: number;
    readonly height: number;
    readonly texture: { readonly type: number };
  };
  addPass(pass: PostPassPort): void;
  setPixelRatio(pixelRatio: number): void;
  setSize(width: number, height: number): void;
  render(deltaTime?: number): void;
  dispose(): void;
}

export interface LightingPostBackend {
  createComposer(renderer: WebGLRenderer): PostComposerPort;
  createRenderPass(scene: Scene, camera: Camera): PostPassPort;
  createBloomPass(): UnrealBloomPassPort;
  createFxaaPass(): FxaaPassPort;
  createOutputPass(): AdaptivePostPassPort;
  createSmaaPass(): AdaptivePostPassPort;
}

interface AdaptiveSmaaInternals {
  readonly _edgesRT: WebGLRenderTarget;
  readonly _weightsRT: WebGLRenderTarget;
  readonly _materialEdges: ShaderMaterial;
  readonly _materialWeights: ShaderMaterial;
  readonly _materialBlend: ShaderMaterial;
}

interface AdaptiveBloomInternals {
  readonly renderTargetBright: WebGLRenderTarget;
  readonly renderTargetsHorizontal: readonly WebGLRenderTarget[];
  readonly renderTargetsVertical: readonly WebGLRenderTarget[];
  readonly materialHighPassFilter: ShaderMaterial;
  readonly separableBlurMaterials: readonly ShaderMaterial[];
  readonly compositeMaterial: ShaderMaterial;
  readonly blendMaterial: ShaderMaterial;
}

function installUvScale(material: ShaderMaterial): void {
  material.uniforms.uAdaptiveUvScale = { value: 1 };
  const scaledVertexShader = material.vertexShader
    .replace('varying vec2 vUv;', 'uniform float uAdaptiveUvScale;\nvarying vec2 vUv;')
    .replace(/vUv = uv;/gu, 'vUv = uv * uAdaptiveUvScale;');
  if (scaledVertexShader === material.vertexShader) {
    throw new Error(`Adaptive post material ${material.name} has no scalable UV assignment.`);
  }
  material.vertexShader = scaledVertexShader;
  material.needsUpdate = true;
}

function setMaterialUvScale(material: ShaderMaterial, scale: number): void {
  const uniform = material.uniforms.uAdaptiveUvScale;
  if (uniform === undefined) throw new Error('Adaptive UV scale uniform is missing.');
  uniform.value = scale;
}

function setTargetViewportScale(target: WebGLRenderTarget, scale: number): void {
  const width = Math.max(1, Math.floor(target.width * scale));
  const height = Math.max(1, Math.floor(target.height * scale));
  target.viewport.set(0, 0, width, height);
  target.scissor.set(0, 0, width, height);
  target.scissorTest = true;
}

class AdaptiveFxaaPass extends ShaderPass implements FxaaPassPort {
  constructor() {
    super(FXAAShader);
    installUvScale(this.material);
  }

  setResolution(width: number, height: number): void {
    const resolution = this.material.uniforms.resolution;
    if (resolution === undefined) throw new Error('FXAA resolution uniform is missing.');
    (resolution.value as Vector2).set(1 / width, 1 / height);
  }

  setRenderScale(scale: number): void {
    setMaterialUvScale(this.material, scale);
  }
}

class AdaptiveOutputPass extends OutputPass implements AdaptivePostPassPort {
  constructor() {
    super();
    installUvScale(this.material);
  }

  setRenderScale(scale: number): void {
    setMaterialUvScale(this.material, scale);
  }
}

class AdaptiveSmaaPass extends SMAAPass implements AdaptivePostPassPort {
  private renderScale = 1;

  constructor() {
    super();
    const internals = this as unknown as AdaptiveSmaaInternals;
    installUvScale(internals._materialEdges);
    installUvScale(internals._materialWeights);
    installUvScale(internals._materialBlend);
  }

  override setSize(width: number, height: number): void {
    super.setSize(width, height);
    this.applyScale();
  }

  setRenderScale(scale: number): void {
    this.renderScale = scale;
    this.applyScale();
  }

  private applyScale(): void {
    const internals = this as unknown as AdaptiveSmaaInternals;
    setTargetViewportScale(internals._edgesRT, this.renderScale);
    setTargetViewportScale(internals._weightsRT, this.renderScale);
    setMaterialUvScale(internals._materialEdges, this.renderScale);
    setMaterialUvScale(internals._materialWeights, this.renderScale);
    setMaterialUvScale(internals._materialBlend, this.renderScale);
  }
}

class AdaptiveBloomPass extends UnrealBloomPass implements UnrealBloomPassPort {
  private renderScale = 1;
  private bloomScale = 1;

  constructor() {
    super(new Vector2(1, 1), BLOOM_STRENGTH, BLOOM_RADIUS, BLOOM_THRESHOLD);
    const internals = this as unknown as AdaptiveBloomInternals;
    installUvScale(internals.materialHighPassFilter);
    for (const material of internals.separableBlurMaterials) installUvScale(material);
    installUvScale(internals.compositeMaterial);
    installUvScale(internals.blendMaterial);
  }

  override setSize(width: number, height: number): void {
    super.setSize(width, height);
    this.applyScale();
  }

  setQualityScale(renderScale: number, bloomScale: number): void {
    this.renderScale = renderScale;
    this.bloomScale = bloomScale;
    this.applyScale();
  }

  private applyScale(): void {
    const internals = this as unknown as AdaptiveBloomInternals;
    const targetScale = this.renderScale * this.bloomScale;
    setTargetViewportScale(internals.renderTargetBright, targetScale);
    for (const target of internals.renderTargetsHorizontal) {
      setTargetViewportScale(target, targetScale);
    }
    for (const target of internals.renderTargetsVertical) {
      setTargetViewportScale(target, targetScale);
    }
    setMaterialUvScale(internals.materialHighPassFilter, this.renderScale);
    for (const material of internals.separableBlurMaterials) {
      setMaterialUvScale(material, targetScale);
    }
    setMaterialUvScale(internals.compositeMaterial, targetScale);
    setMaterialUvScale(internals.blendMaterial, targetScale);
  }
}

const THREE_POST_BACKEND: LightingPostBackend = {
  createComposer: (renderer) => new EffectComposer(renderer) as unknown as PostComposerPort,
  createRenderPass: (scene, camera) => new RenderPass(scene, camera) as unknown as PostPassPort,
  createBloomPass: () => new AdaptiveBloomPass(),
  createFxaaPass: () => new AdaptiveFxaaPass(),
  createOutputPass: () => new AdaptiveOutputPass(),
  createSmaaPass: () => new AdaptiveSmaaPass(),
};

function assertPositiveFinite(label: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be positive and finite: ${value}`);
  }
}

/** Owns the single half-float RenderPass → bloom → ACES OutputPass chain. */
export class LightingPostPipeline {
  readonly composer: PostComposerPort;
  readonly renderPass: PostPassPort;
  readonly bloomPass: UnrealBloomPassPort;
  readonly fxaaPass: FxaaPassPort;
  readonly outputPass: AdaptivePostPassPort;
  readonly smaaPass: AdaptivePostPassPort;

  private pixelRatio: number;
  private renderScale = 1;
  private bloomResolution: Exclude<BloomQuality, 'off'> = 'full';

  constructor(
    private readonly renderer: WebGLRenderer,
    private readonly scene: Scene,
    private readonly camera: Camera,
    backend: LightingPostBackend = THREE_POST_BACKEND,
  ) {
    renderer.toneMapping = ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1;
    this.pixelRatio = renderer.getPixelRatio();

    this.composer = backend.createComposer(renderer);
    this.renderPass = backend.createRenderPass(scene, camera);
    this.bloomPass = backend.createBloomPass();
    this.smaaPass = backend.createSmaaPass();
    this.fxaaPass = backend.createFxaaPass();
    this.outputPass = backend.createOutputPass();
    this.bloomPass.threshold = BLOOM_THRESHOLD;
    this.bloomPass.strength = BLOOM_STRENGTH;
    this.bloomPass.radius = BLOOM_RADIUS;
    this.smaaPass.enabled = true;
    this.fxaaPass.enabled = false;
    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(this.smaaPass);
    this.composer.addPass(this.fxaaPass);
    this.composer.addPass(this.outputPass);

    if (
      this.composer.readBuffer.texture.type !== HalfFloatType ||
      this.composer.writeBuffer.texture.type !== HalfFloatType
    ) {
      throw new Error('Lighting post-processing requires half-float composer buffers.');
    }
  }

  resize(width: number, height: number, pixelRatio: number): void {
    assertPositiveFinite('Post-processing width', width);
    assertPositiveFinite('Post-processing height', height);
    assertPositiveFinite('Post-processing pixel ratio', pixelRatio);
    if (pixelRatio !== this.pixelRatio) {
      this.composer.setPixelRatio(pixelRatio);
      this.pixelRatio = pixelRatio;
    }
    this.composer.setSize(width, height);
    const effectiveWidth = Math.max(1, Math.floor(width * pixelRatio));
    const effectiveHeight = Math.max(1, Math.floor(height * pixelRatio));
    this.fxaaPass.setResolution(effectiveWidth, effectiveHeight);
    this.applyQualityScale();
  }

  setBloomEnabled(enabled: boolean): void {
    this.setBloomQuality(enabled ? 'full' : 'off');
  }

  setBloomQuality(quality: BloomQuality): void {
    if (quality !== 'full' && quality !== 'half' && quality !== 'off') {
      throw new RangeError('Unknown bloom quality.');
    }
    this.bloomPass.enabled = quality !== 'off';
    if (quality !== 'off') this.bloomResolution = quality;
    this.bloomPass.setQualityScale(this.renderScale, this.bloomResolution === 'half' ? 0.5 : 1);
  }

  setAntiAliasing(quality: AntiAliasingQuality): void {
    if (quality !== 'smaa' && quality !== 'fxaa' && quality !== 'off') {
      throw new RangeError('Unknown anti-aliasing quality.');
    }
    this.smaaPass.enabled = quality === 'smaa';
    this.fxaaPass.enabled = quality === 'fxaa';
  }

  selectQuality(profile: RenderQualityProfile, postProcessingAvailable = true): void {
    this.renderScale = profile.renderScale;
    this.applyQualityScale();
    this.setBloomQuality(postProcessingAvailable ? profile.bloom : 'off');
    this.setAntiAliasing(postProcessingAvailable ? profile.antiAliasing : 'off');
  }

  /** Compiles and initializes the selected render path before the first animation frame. */
  warmUp(postProcessingEnabled = true): void {
    if (postProcessingEnabled) {
      const bloomEnabled = this.bloomPass.enabled;
      const smaaEnabled = this.smaaPass.enabled;
      const fxaaEnabled = this.fxaaPass.enabled;
      this.bloomPass.enabled = true;
      this.smaaPass.enabled = true;
      this.fxaaPass.enabled = true;
      this.composer.render(0);
      this.bloomPass.enabled = bloomEnabled;
      this.smaaPass.enabled = smaaEnabled;
      this.fxaaPass.enabled = fxaaEnabled;
      return;
    }
    this.renderer.render(this.scene, this.camera);
  }

  /** Performs the preallocated post chain without application-owned allocations. */
  render(postProcessingEnabled = true): void {
    if (postProcessingEnabled) {
      this.composer.render();
      return;
    }
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.renderPass.dispose();
    this.bloomPass.dispose();
    this.smaaPass.dispose();
    this.fxaaPass.dispose();
    this.outputPass.dispose();
    this.composer.dispose();
  }

  private applyQualityScale(): void {
    const readBuffer = this.composer.readBuffer as unknown as WebGLRenderTarget;
    const writeBuffer = this.composer.writeBuffer as unknown as WebGLRenderTarget;
    setTargetViewportScale(readBuffer, this.renderScale);
    setTargetViewportScale(writeBuffer, this.renderScale);
    this.smaaPass.setRenderScale(this.renderScale);
    this.fxaaPass.setRenderScale(this.renderScale);
    this.outputPass.setRenderScale(this.renderScale);
    this.bloomPass.setQualityScale(this.renderScale, this.bloomResolution === 'half' ? 0.5 : 1);
  }
}
