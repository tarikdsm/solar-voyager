import {
  ACESFilmicToneMapping,
  HalfFloatType,
  Vector2,
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

import type { AntiAliasingQuality, BloomQuality } from './perfGovernor.js';

export const BLOOM_THRESHOLD = 1;
export const BLOOM_STRENGTH = 0.15;
export const BLOOM_RADIUS = 0.35;

export interface PostPassPort {
  enabled: boolean;
  setSize(width: number, height: number): void;
  dispose(): void;
}

export interface UnrealBloomPassPort extends PostPassPort {
  threshold: number;
  strength: number;
  radius: number;
}

export interface FxaaPassPort extends PostPassPort {
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
  createOutputPass(): PostPassPort;
  createSmaaPass(): PostPassPort;
}

class ReusableFxaaPass extends ShaderPass implements FxaaPassPort {
  constructor() {
    super(FXAAShader);
  }

  setResolution(width: number, height: number): void {
    const resolution = this.material.uniforms.resolution;
    if (resolution === undefined) throw new Error('FXAA resolution uniform is missing.');
    (resolution.value as Vector2).set(1 / width, 1 / height);
  }
}

const THREE_POST_BACKEND: LightingPostBackend = {
  createComposer: (renderer) => new EffectComposer(renderer) as unknown as PostComposerPort,
  createRenderPass: (scene, camera) => new RenderPass(scene, camera) as unknown as PostPassPort,
  createBloomPass: () =>
    new UnrealBloomPass(
      new Vector2(1, 1),
      BLOOM_STRENGTH,
      BLOOM_RADIUS,
      BLOOM_THRESHOLD,
    ) as unknown as UnrealBloomPassPort,
  createFxaaPass: () => new ReusableFxaaPass(),
  createOutputPass: () => new OutputPass() as unknown as PostPassPort,
  createSmaaPass: () => new SMAAPass() as unknown as PostPassPort,
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
  readonly outputPass: PostPassPort;
  readonly smaaPass: PostPassPort;

  private pixelRatio: number;
  private width = 1;
  private height = 1;
  private bloomQuality: BloomQuality = 'full';

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
    this.width = width;
    this.height = height;
    this.composer.setSize(width, height);
    const effectiveWidth = Math.max(1, Math.floor(width * pixelRatio));
    const effectiveHeight = Math.max(1, Math.floor(height * pixelRatio));
    this.fxaaPass.setResolution(effectiveWidth, effectiveHeight);
    this.resizeBloom();
  }

  setBloomEnabled(enabled: boolean): void {
    this.setBloomQuality(enabled ? 'full' : 'off');
  }

  setBloomQuality(quality: BloomQuality): void {
    if (quality !== 'full' && quality !== 'half' && quality !== 'off') {
      throw new RangeError('Unknown bloom quality.');
    }
    this.bloomQuality = quality;
    this.bloomPass.enabled = quality !== 'off';
    this.resizeBloom();
  }

  setAntiAliasing(quality: AntiAliasingQuality): void {
    if (quality !== 'smaa' && quality !== 'fxaa' && quality !== 'off') {
      throw new RangeError('Unknown anti-aliasing quality.');
    }
    this.smaaPass.enabled = quality === 'smaa';
    this.fxaaPass.enabled = quality === 'fxaa';
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

  private resizeBloom(): void {
    const scale = this.bloomQuality === 'half' ? 0.5 : 1;
    this.bloomPass.setSize(
      Math.max(1, Math.floor(this.width * this.pixelRatio * scale)),
      Math.max(1, Math.floor(this.height * this.pixelRatio * scale)),
    );
  }
}
