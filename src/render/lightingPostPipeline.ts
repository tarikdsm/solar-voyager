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
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

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

export interface PostComposerPort {
  readonly passes: PostPassPort[];
  readonly readBuffer: { readonly texture: { readonly type: number } };
  readonly writeBuffer: { readonly texture: { readonly type: number } };
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
  createOutputPass(): PostPassPort;
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
  createOutputPass: () => new OutputPass() as unknown as PostPassPort,
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
  readonly outputPass: PostPassPort;

  private pixelRatio: number;

  constructor(
    renderer: WebGLRenderer,
    scene: Scene,
    camera: Camera,
    backend: LightingPostBackend = THREE_POST_BACKEND,
  ) {
    renderer.toneMapping = ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1;
    this.pixelRatio = renderer.getPixelRatio();

    this.composer = backend.createComposer(renderer);
    this.renderPass = backend.createRenderPass(scene, camera);
    this.bloomPass = backend.createBloomPass();
    this.outputPass = backend.createOutputPass();
    this.bloomPass.threshold = BLOOM_THRESHOLD;
    this.bloomPass.strength = BLOOM_STRENGTH;
    this.bloomPass.radius = BLOOM_RADIUS;
    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.bloomPass);
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
  }

  setBloomEnabled(enabled: boolean): void {
    this.bloomPass.enabled = enabled;
  }

  /** Compiles and initializes post shaders before the first animation frame. */
  warmUp(): void {
    this.composer.render(0);
  }

  /** Performs the preallocated post chain without application-owned allocations. */
  render(): void {
    this.composer.render();
  }

  dispose(): void {
    this.renderPass.dispose();
    this.bloomPass.dispose();
    this.outputPass.dispose();
    this.composer.dispose();
  }
}
