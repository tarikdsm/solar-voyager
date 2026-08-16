import {
  ACESFilmicToneMapping,
  HalfFloatType,
  REVISION,
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
import { RelativisticPostPass, type RelativisticPostPassPort } from './relativisticPostPass.js';

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
  insertPass(pass: PostPassPort, index: number): void;
  setPixelRatio(pixelRatio: number): void;
  setSize(width: number, height: number): void;
  render(deltaTime?: number): void;
  dispose(): void;
}

/**
 * The ordering seams a caller may attach a post pass to.
 *
 * The chain is a fixed spine of six pipeline-owned passes; an anchor names the
 * seam *after* one of them:
 *
 * ```
 * RenderPass                         <- always first
 *   'scene'          raw HDR scene, before relativistic aberration
 * RelativisticPostPass
 *   'relativistic'   aberrated image, still pre-bloom (god rays, T0142)
 * AdaptiveBloomPass
 *   'bloom'          bloomed image, before anti-aliasing (lens flare, T0142)
 * AdaptiveSmaaPass, AdaptiveFxaaPass
 *   'anti-aliasing'  resolved image, before tone mapping
 * AdaptiveOutputPass                 <- always last; owns ACES tone mapping
 * ```
 *
 * Ordering contract, in full:
 *
 * 1. A pass lands immediately after its anchor's spine pass, and after every pass
 *    already inserted at the same anchor. Order is therefore a pure function of
 *    (anchor, insertion sequence) — never of module import order.
 * 2. Nothing may precede `RenderPass` or follow `AdaptiveOutputPass`. Tone mapping
 *    and output colour conversion happen exactly once, at the end.
 * 3. The pipeline takes ownership: inserted passes are sized by the composer,
 *    receive `setRenderScale` when they implement it, are force-enabled for the
 *    warm-up render (shader precompilation, performance-spec §5), and are disposed
 *    in reverse insertion order by {@link LightingPostPipeline.dispose}.
 * 4. Inserting nothing leaves the default six-pass order byte-identical — the
 *    frozen `passNames` assertion in `tools/tests/lightingPostRegression.mjs` is
 *    the gate that proves it.
 */
export const POST_PASS_ANCHORS = Object.freeze([
  'scene',
  'relativistic',
  'bloom',
  'anti-aliasing',
] as const);

export type PostPassAnchor = (typeof POST_PASS_ANCHORS)[number];

/** Count of pipeline-owned passes preceding each anchor's insertion block. */
const ANCHOR_SPINE_PREFIX = Object.freeze([1, 2, 3, 5]);

/** Sink for the single `toneMappingExposure` writer (`exposureController.ts`). */
export interface ExposureSinkPort {
  setExposure(exposure: number): void;
}

export interface LightingPostBackend {
  createComposer(renderer: WebGLRenderer): PostComposerPort;
  createRenderPass(scene: Scene, camera: Camera): PostPassPort;
  createBloomPass(): UnrealBloomPassPort;
  createFxaaPass(): FxaaPassPort;
  createOutputPass(): AdaptivePostPassPort;
  createRelativisticPass(): RelativisticPostPassPort;
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

/**
 * The three.js revision the private-field reads below were validated against.
 *
 * Adaptive render scaling needs SMAA's internal render targets and bloom's blur
 * chain, and neither is exported. That dependency is real but it must never be
 * silent: `lightingPostPipeline.canary.test.ts` fails the build when the installed
 * revision moves away from this constant, so a three.js bump is forced to re-run
 * the private-field validation deliberately instead of discovering the breakage in
 * a browser gate.
 */
export const VALIDATED_THREE_REVISION = '185';

export const SMAA_INTERNAL_FIELDS = Object.freeze([
  '_edgesRT',
  '_weightsRT',
  '_materialEdges',
  '_materialWeights',
  '_materialBlend',
] as const);

export const BLOOM_INTERNAL_FIELDS = Object.freeze([
  'renderTargetBright',
  'renderTargetsHorizontal',
  'renderTargetsVertical',
  'materialHighPassFilter',
  'separableBlurMaterials',
  'compositeMaterial',
  'blendMaterial',
] as const);

/**
 * Narrows a three.js pass to the private fields this module mutates, failing at
 * construction with the field name rather than mid-resize with a `TypeError`.
 */
export function assertPassInternals<T>(
  ownerLabel: string,
  owner: object,
  fields: readonly string[],
): T {
  const record = owner as Record<string, unknown>;
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index] as string;
    if (record[field] === undefined || record[field] === null) {
      throw new Error(
        `${ownerLabel} no longer exposes the three.js internal "${field}". ` +
          `Adaptive post-processing was validated against three.js r${VALIDATED_THREE_REVISION} ` +
          `(installed r${REVISION}); re-validate the private-field contract before bumping three.js.`,
      );
    }
  }
  return owner as T;
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
  private readonly internals: AdaptiveSmaaInternals;

  constructor() {
    super();
    const internals = assertPassInternals<AdaptiveSmaaInternals>(
      'AdaptiveSmaaPass',
      this,
      SMAA_INTERNAL_FIELDS,
    );
    this.internals = internals;
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
    const internals = this.internals;
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
  private readonly internals: AdaptiveBloomInternals;

  constructor() {
    super(new Vector2(1, 1), BLOOM_STRENGTH, BLOOM_RADIUS, BLOOM_THRESHOLD);
    const internals = assertPassInternals<AdaptiveBloomInternals>(
      'AdaptiveBloomPass',
      this,
      BLOOM_INTERNAL_FIELDS,
    );
    this.internals = internals;
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
    const internals = this.internals;
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

export const DEFAULT_POST_BACKEND: LightingPostBackend = {
  createComposer: (renderer) => new EffectComposer(renderer) as unknown as PostComposerPort,
  createRenderPass: (scene, camera) => new RenderPass(scene, camera) as unknown as PostPassPort,
  createBloomPass: () => new AdaptiveBloomPass(),
  createFxaaPass: () => new AdaptiveFxaaPass(),
  createOutputPass: () => new AdaptiveOutputPass(),
  createRelativisticPass: () => new RelativisticPostPass(),
  createSmaaPass: () => new AdaptiveSmaaPass(),
};

function assertPositiveFinite(label: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be positive and finite: ${value}`);
  }
}

/** Detected once, at insertion time, so the render-scale walk stays branch-free. */
function isAdaptivePass(pass: PostPassPort): pass is AdaptivePostPassPort {
  return typeof (pass as Partial<AdaptivePostPassPort>).setRenderScale === 'function';
}

/**
 * Owns the single half-float RenderPass → bloom → AA → ACES OutputPass chain, the
 * seams other subsystems attach passes to ({@link POST_PASS_ANCHORS}), and the one
 * write to `renderer.toneMappingExposure`.
 */
export class LightingPostPipeline implements ExposureSinkPort {
  readonly composer: PostComposerPort;
  readonly renderPass: PostPassPort;
  readonly relativisticPass: RelativisticPostPassPort;
  readonly bloomPass: UnrealBloomPassPort;
  readonly fxaaPass: FxaaPassPort;
  readonly outputPass: AdaptivePostPassPort;
  readonly smaaPass: AdaptivePostPassPort;

  private pixelRatio: number;
  private renderScale = 1;
  private bloomResolution: Exclude<BloomQuality, 'off'> = 'full';
  /** Inserted passes in chain order; parallel arrays keep the frame path cold. */
  private readonly insertedPasses: PostPassPort[] = [];
  private readonly insertedAdaptivePasses: (AdaptivePostPassPort | null)[] = [];
  private readonly insertedEnabled: boolean[] = [];
  private readonly anchorCounts = new Int32Array(POST_PASS_ANCHORS.length);

  constructor(
    private readonly renderer: WebGLRenderer,
    private readonly scene: Scene,
    private readonly camera: Camera,
    backend: LightingPostBackend = DEFAULT_POST_BACKEND,
    /**
     * Gain applied to every {@link setExposure} value.
     *
     * The direct (post-processing unavailable) path has no bloom to carry the
     * highlights, so it has always compensated with a fixed exposure of 3. Folding
     * that in here keeps `setExposure(1)` byte-for-byte identical to the pre-T0127
     * behaviour of *both* paths, which is what makes the `fixed` exposure mode an
     * exact rollback rather than an approximation.
     */
    private readonly baseExposure = 1,
  ) {
    assertPositiveFinite('Base exposure', baseExposure);
    renderer.toneMapping = ACESFilmicToneMapping;
    renderer.toneMappingExposure = baseExposure;
    this.pixelRatio = renderer.getPixelRatio();

    this.composer = backend.createComposer(renderer);
    this.renderPass = backend.createRenderPass(scene, camera);
    this.relativisticPass = backend.createRelativisticPass();
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
    this.composer.addPass(this.relativisticPass);
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

  /**
   * Inserts `pass` at the seam named by `anchor`, per the ordering contract on
   * {@link POST_PASS_ANCHORS}. Setup-time only — never call this from the frame loop.
   */
  insertPass(pass: PostPassPort, anchor: PostPassAnchor): void {
    const anchorIndex = POST_PASS_ANCHORS.indexOf(anchor);
    if (anchorIndex < 0) {
      throw new RangeError(
        `Unknown post-processing anchor "${String(anchor)}"; expected one of ${POST_PASS_ANCHORS.join(', ')}.`,
      );
    }
    if (this.composer.passes.includes(pass)) {
      throw new Error('This post-processing pass is already in the chain.');
    }
    const prefix = ANCHOR_SPINE_PREFIX[anchorIndex];
    if (prefix === undefined) throw new Error('Post-processing anchor table is inconsistent.');
    let insertIndex = prefix;
    for (let index = 0; index <= anchorIndex; index += 1) {
      insertIndex += this.anchorCounts[index] as number;
    }
    this.composer.insertPass(pass, insertIndex);
    this.anchorCounts[anchorIndex] = (this.anchorCounts[anchorIndex] as number) + 1;
    const adaptive = isAdaptivePass(pass) ? pass : null;
    // Chain order and bookkeeping order must agree, or dispose and warm-up would
    // walk a different chain than the composer renders.
    const bookkeepingIndex = insertIndex - prefix;
    this.insertedPasses.splice(bookkeepingIndex, 0, pass);
    this.insertedAdaptivePasses.splice(bookkeepingIndex, 0, adaptive);
    this.insertedEnabled.splice(bookkeepingIndex, 0, pass.enabled);
    adaptive?.setRenderScale(this.renderScale);
  }

  /**
   * The single write to `renderer.toneMappingExposure` (`exposureController.ts`
   * owns the value; plan §3.5).
   */
  setExposure(exposure: number): void {
    assertPositiveFinite('Tone mapping exposure', exposure);
    this.renderer.toneMappingExposure = this.baseExposure * exposure;
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
      const relativisticEnabled = this.relativisticPass.enabled;
      const smaaEnabled = this.smaaPass.enabled;
      const fxaaEnabled = this.fxaaPass.enabled;
      this.bloomPass.enabled = true;
      this.relativisticPass.enabled = true;
      this.smaaPass.enabled = true;
      this.fxaaPass.enabled = true;
      for (let index = 0; index < this.insertedPasses.length; index += 1) {
        const inserted = this.insertedPasses[index] as PostPassPort;
        this.insertedEnabled[index] = inserted.enabled;
        inserted.enabled = true;
      }
      this.composer.render(0);
      this.bloomPass.enabled = bloomEnabled;
      this.relativisticPass.enabled = relativisticEnabled;
      this.smaaPass.enabled = smaaEnabled;
      this.fxaaPass.enabled = fxaaEnabled;
      for (let index = 0; index < this.insertedPasses.length; index += 1) {
        (this.insertedPasses[index] as PostPassPort).enabled = this.insertedEnabled[
          index
        ] as boolean;
      }
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
    for (let index = this.insertedPasses.length - 1; index >= 0; index -= 1) {
      (this.insertedPasses[index] as PostPassPort).dispose();
    }
    this.renderPass.dispose();
    this.relativisticPass.dispose();
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
    this.relativisticPass.setRenderScale(this.renderScale);
    this.fxaaPass.setRenderScale(this.renderScale);
    this.outputPass.setRenderScale(this.renderScale);
    this.bloomPass.setQualityScale(this.renderScale, this.bloomResolution === 'half' ? 0.5 : 1);
    for (let index = 0; index < this.insertedAdaptivePasses.length; index += 1) {
      this.insertedAdaptivePasses[index]?.setRenderScale(this.renderScale);
    }
  }
}
