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
    selectQuality: vi.fn(),
  };
  const starfield = { setCountCap: vi.fn(), setPixelRatio: vi.fn() };
  const proceduralSun = { setQuality: vi.fn() };
  const assetLoader = { setTextureTierCap: vi.fn() };
  const visualSystem = { setModelThresholdScale: vi.fn(), setRingParticleCount: vi.fn() };
  const relativisticVisuals = { setQualityEnabled: vi.fn() };
  const controller = new RenderQualityController({
    assetLoader,
    pipeline,
    postProcessingAvailable,
    proceduralSun,
    renderer,
    relativisticVisuals,
    starfield,
    visualSystem,
  });
  return {
    assetLoader,
    controller,
    pipeline,
    proceduralSun,
    renderer,
    relativisticVisuals,
    starfield,
    visualSystem,
  };
}

describe('RenderQualityController', () => {
  it('applies every scalar knob without resizing runtime render targets', () => {
    const target = QUALITY_PROFILES[12];
    if (target === undefined) throw new Error('test profile missing');
    const subject = fixture();

    subject.controller.apply(target);

    expect(subject.renderer.setPixelRatio).not.toHaveBeenCalled();
    expect(subject.pipeline.selectQuality).toHaveBeenCalledWith(target, true);
    expect(subject.starfield.setPixelRatio).toHaveBeenCalledWith(1.1);
    expect(subject.starfield.setCountCap).toHaveBeenCalledWith(2_000);
    expect(subject.proceduralSun.setQuality).toHaveBeenCalledWith('minimum');
    expect(subject.assetLoader.setTextureTierCap).toHaveBeenCalledWith('2k');
    expect(subject.visualSystem.setModelThresholdScale).toHaveBeenCalledWith(1);
    expect(subject.visualSystem.setRingParticleCount).toHaveBeenCalledWith(0);
    expect(subject.relativisticVisuals.setQualityEnabled).toHaveBeenCalledWith(false);

    const full = QUALITY_PROFILES[0];
    if (full === undefined) throw new Error('full profile missing');
    subject.controller.apply(full);
    expect(subject.pipeline.selectQuality).toHaveBeenLastCalledWith(full, true);
    expect(subject.relativisticVisuals.setQualityEnabled).toHaveBeenLastCalledWith(true);
  });

  it('does not reapply the same rung and keeps post effects off on software rendering', () => {
    const target = QUALITY_PROFILES[0];
    if (target === undefined) throw new Error('test profile missing');
    const subject = fixture(false);

    subject.controller.apply(target);
    subject.controller.apply(target);

    expect(subject.pipeline.selectQuality).toHaveBeenCalledOnce();
    expect(subject.pipeline.selectQuality).toHaveBeenCalledWith(target, false);
    expect(subject.relativisticVisuals.setQualityEnabled).toHaveBeenCalledOnce();
    expect(subject.relativisticVisuals.setQualityEnabled).toHaveBeenCalledWith(false);
    expect(subject.visualSystem.setRingParticleCount).toHaveBeenCalledOnce();
  });
});
