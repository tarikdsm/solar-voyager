import type { WebGLRenderer } from 'three';
import { describe, expect, it, vi } from 'vitest';

import { QUALITY_PROFILES } from './perfGovernor.js';
import { RenderQualityController } from './renderQualityController.js';

function fixture(postProcessingAvailable = true) {
  let pixelRatio = 2;
  const renderer = {
    getPixelRatio: () => pixelRatio,
    setPixelRatio: vi.fn((value: number) => {
      pixelRatio = value;
    }),
  } as unknown as WebGLRenderer;
  const pipeline = {
    setAntiAliasing: vi.fn(),
    setBloomQuality: vi.fn(),
  };
  const starfield = { setCountCap: vi.fn(), setPixelRatio: vi.fn() };
  const proceduralSun = { setQuality: vi.fn() };
  const assetLoader = { setTextureTierCap: vi.fn() };
  const visualSystem = { setModelThresholdScale: vi.fn() };
  const resize = vi.fn();
  const controller = new RenderQualityController({
    assetLoader,
    pipeline,
    postProcessingAvailable,
    proceduralSun,
    renderer,
    resize,
    starfield,
    visualSystem,
  });
  return {
    assetLoader,
    controller,
    pipeline,
    proceduralSun,
    renderer,
    resize,
    starfield,
    visualSystem,
  };
}

describe('RenderQualityController', () => {
  it('applies every scalar knob and resizes from the immutable startup pixel ratio', () => {
    const target = QUALITY_PROFILES[12];
    if (target === undefined) throw new Error('test profile missing');
    const subject = fixture();

    subject.controller.apply(target);

    expect(subject.renderer.setPixelRatio).toHaveBeenCalledWith(1.1);
    expect(subject.pipeline.setBloomQuality).toHaveBeenCalledWith('off');
    expect(subject.pipeline.setAntiAliasing).toHaveBeenCalledWith('off');
    expect(subject.starfield.setPixelRatio).toHaveBeenCalledWith(1.1);
    expect(subject.starfield.setCountCap).toHaveBeenCalledWith(2_000);
    expect(subject.proceduralSun.setQuality).toHaveBeenCalledWith('minimum');
    expect(subject.assetLoader.setTextureTierCap).toHaveBeenCalledWith('2k');
    expect(subject.visualSystem.setModelThresholdScale).toHaveBeenCalledWith(1);
    expect(subject.resize).toHaveBeenCalledOnce();

    const full = QUALITY_PROFILES[0];
    if (full === undefined) throw new Error('full profile missing');
    subject.controller.apply(full);
    expect(subject.renderer.setPixelRatio).toHaveBeenLastCalledWith(2);
  });

  it('does not reapply the same rung and keeps post effects off on software rendering', () => {
    const target = QUALITY_PROFILES[0];
    if (target === undefined) throw new Error('test profile missing');
    const subject = fixture(false);

    subject.controller.apply(target);
    subject.controller.apply(target);

    expect(subject.pipeline.setBloomQuality).toHaveBeenCalledOnce();
    expect(subject.pipeline.setBloomQuality).toHaveBeenCalledWith('off');
    expect(subject.pipeline.setAntiAliasing).toHaveBeenCalledOnce();
    expect(subject.pipeline.setAntiAliasing).toHaveBeenCalledWith('off');
    expect(subject.resize).toHaveBeenCalledOnce();
  });
});
