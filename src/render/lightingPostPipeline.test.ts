import {
  ACESFilmicToneMapping,
  HalfFloatType,
  NoToneMapping,
  PerspectiveCamera,
  Scene,
  type WebGLRenderer,
} from 'three';
import { describe, expect, it, vi } from 'vitest';

import {
  BLOOM_RADIUS,
  BLOOM_STRENGTH,
  BLOOM_THRESHOLD,
  LightingPostPipeline,
  type FxaaPassPort,
  type LightingPostBackend,
  type PostComposerPort,
  type PostPassPort,
  type UnrealBloomPassPort,
} from './lightingPostPipeline.js';

interface Fixture {
  readonly backend: LightingPostBackend;
  readonly bloomPass: UnrealBloomPassPort;
  readonly composer: PostComposerPort;
  readonly fxaaPass: FxaaPassPort;
  readonly outputPass: PostPassPort;
  readonly renderPass: PostPassPort;
  readonly renderer: WebGLRenderer;
  readonly smaaPass: PostPassPort;
}

function pass(): PostPassPort {
  return {
    enabled: true,
    setSize: vi.fn(),
    dispose: vi.fn(),
  };
}

function createFixture(): Fixture {
  const renderPass = pass();
  const outputPass = pass();
  const smaaPass = pass();
  const fxaaPass: FxaaPassPort = { ...pass(), setResolution: vi.fn() };
  const bloomPass: UnrealBloomPassPort = {
    ...pass(),
    threshold: -1,
    strength: -1,
    radius: -1,
  };
  const passes: PostPassPort[] = [];
  const composer: PostComposerPort = {
    passes,
    readBuffer: { width: 1, height: 1, texture: { type: HalfFloatType } },
    writeBuffer: { width: 1, height: 1, texture: { type: HalfFloatType } },
    addPass: vi.fn((candidate: PostPassPort) => passes.push(candidate)),
    setPixelRatio: vi.fn(),
    setSize: vi.fn(),
    render: vi.fn(),
    dispose: vi.fn(),
  };
  const backend: LightingPostBackend = {
    createComposer: vi.fn(() => composer),
    createRenderPass: vi.fn(() => renderPass),
    createBloomPass: vi.fn(() => bloomPass),
    createFxaaPass: vi.fn(() => fxaaPass),
    createOutputPass: vi.fn(() => outputPass),
    createSmaaPass: vi.fn(() => smaaPass),
  };
  const renderer = {
    toneMapping: NoToneMapping,
    toneMappingExposure: 2,
    getPixelRatio: () => 2,
    render: vi.fn(),
  } as unknown as WebGLRenderer;
  return { backend, bloomPass, composer, fxaaPass, outputPass, renderPass, renderer, smaaPass };
}

describe('LightingPostPipeline', () => {
  it('configures ACES and one ordered reusable render/bloom/AA/output chain', () => {
    const fixture = createFixture();
    const scene = new Scene();
    const camera = new PerspectiveCamera();
    const pipeline = new LightingPostPipeline(fixture.renderer, scene, camera, fixture.backend);

    expect(fixture.renderer.toneMapping).toBe(ACESFilmicToneMapping);
    expect(fixture.renderer.toneMappingExposure).toBe(1);
    expect(fixture.backend.createComposer).toHaveBeenCalledWith(fixture.renderer);
    expect(fixture.backend.createRenderPass).toHaveBeenCalledWith(scene, camera);
    expect(fixture.backend.createBloomPass).toHaveBeenCalledOnce();
    expect(fixture.backend.createOutputPass).toHaveBeenCalledOnce();
    expect(fixture.composer.passes).toEqual([
      fixture.renderPass,
      fixture.bloomPass,
      fixture.smaaPass,
      fixture.fxaaPass,
      fixture.outputPass,
    ]);
    expect(fixture.composer.readBuffer.texture.type).toBe(HalfFloatType);
    expect(fixture.composer.writeBuffer.texture.type).toBe(HalfFloatType);
    expect(pipeline.renderPass).toBe(fixture.renderPass);
    expect(pipeline.outputPass).toBe(fixture.outputPass);
    expect(pipeline.bloomPass).toBe(fixture.bloomPass);
    expect(pipeline.smaaPass).toBe(fixture.smaaPass);
    expect(pipeline.fxaaPass).toBe(fixture.fxaaPass);
    expect(fixture.smaaPass.enabled).toBe(true);
    expect(fixture.fxaaPass.enabled).toBe(false);
    expect(fixture.bloomPass.threshold).toBe(BLOOM_THRESHOLD);
    expect(fixture.bloomPass.strength).toBe(BLOOM_STRENGTH);
    expect(fixture.bloomPass.radius).toBe(BLOOM_RADIUS);
  });

  it('resizes existing buffers, toggles the existing bloom pass, and delegates rendering', () => {
    const fixture = createFixture();
    const scene = new Scene();
    const camera = new PerspectiveCamera();
    const pipeline = new LightingPostPipeline(fixture.renderer, scene, camera, fixture.backend);

    pipeline.resize(800, 600, 2);
    expect(fixture.composer.setPixelRatio).not.toHaveBeenCalled();
    expect(fixture.composer.setSize).toHaveBeenLastCalledWith(800, 600);

    pipeline.resize(640, 360, 1);
    expect(fixture.composer.setPixelRatio).toHaveBeenCalledOnce();
    expect(fixture.composer.setPixelRatio).toHaveBeenLastCalledWith(1);
    expect(fixture.composer.setSize).toHaveBeenLastCalledWith(640, 360);
    expect(fixture.fxaaPass.setResolution).toHaveBeenLastCalledWith(640, 360);

    pipeline.setBloomQuality('half');
    expect(fixture.bloomPass.enabled).toBe(true);
    expect(fixture.bloomPass.setSize).toHaveBeenLastCalledWith(320, 180);
    pipeline.setBloomQuality('off');
    expect(fixture.bloomPass.enabled).toBe(false);
    pipeline.setBloomQuality('full');
    expect(fixture.bloomPass.setSize).toHaveBeenLastCalledWith(640, 360);

    pipeline.setAntiAliasing('fxaa');
    expect(fixture.smaaPass.enabled).toBe(false);
    expect(fixture.fxaaPass.enabled).toBe(true);
    pipeline.setAntiAliasing('off');
    expect(fixture.fxaaPass.enabled).toBe(false);
    pipeline.setAntiAliasing('smaa');
    expect(fixture.smaaPass.enabled).toBe(true);

    pipeline.setBloomEnabled(false);
    expect(fixture.bloomPass.enabled).toBe(false);
    pipeline.setBloomEnabled(true);
    expect(fixture.bloomPass.enabled).toBe(true);

    pipeline.warmUp();
    pipeline.render();
    expect(fixture.composer.render).toHaveBeenNthCalledWith(1, 0);
    expect(fixture.composer.render).toHaveBeenNthCalledWith(2);

    pipeline.warmUp(false);
    pipeline.render(false);
    expect(fixture.composer.render).toHaveBeenCalledTimes(2);
    expect(fixture.renderer.render).toHaveBeenCalledTimes(2);
    expect(fixture.renderer.render).toHaveBeenNthCalledWith(1, scene, camera);
    expect(fixture.renderer.render).toHaveBeenNthCalledWith(2, scene, camera);
  });

  it('rejects invalid dimensions and pixel ratios', () => {
    const fixture = createFixture();
    const pipeline = new LightingPostPipeline(
      fixture.renderer,
      new Scene(),
      new PerspectiveCamera(),
      fixture.backend,
    );

    expect(() => pipeline.resize(0, 600, 1)).toThrow(/width/iu);
    expect(() => pipeline.resize(800, Number.NaN, 1)).toThrow(/height/iu);
    expect(() => pipeline.resize(800, 600, 0)).toThrow(/pixel ratio/iu);
  });

  it('disposes each owned pass and composer once', () => {
    const fixture = createFixture();
    const pipeline = new LightingPostPipeline(
      fixture.renderer,
      new Scene(),
      new PerspectiveCamera(),
      fixture.backend,
    );

    pipeline.dispose();

    expect(fixture.renderPass.dispose).toHaveBeenCalledOnce();
    expect(fixture.bloomPass.dispose).toHaveBeenCalledOnce();
    expect(fixture.smaaPass.dispose).toHaveBeenCalledOnce();
    expect(fixture.fxaaPass.dispose).toHaveBeenCalledOnce();
    expect(fixture.outputPass.dispose).toHaveBeenCalledOnce();
    expect(fixture.composer.dispose).toHaveBeenCalledOnce();
  });
});
