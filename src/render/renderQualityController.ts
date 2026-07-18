import type { WebGLRenderer } from 'three';

import type {
  RenderQualityApplicationPort,
  RenderQualityProfile,
  TextureQualityCap,
} from './perfGovernor.js';
import type { ProceduralSunQuality } from './proceduralSunState.js';

export interface QualityPostPipelinePort {
  selectQuality(profile: RenderQualityProfile, postProcessingAvailable: boolean): void;
}

export interface QualityStarfieldPort {
  setCountCap(countCap: number): void;
  setPixelRatio(pixelRatio: number): void;
}

export interface QualityProceduralPort {
  setQuality(quality: ProceduralSunQuality): void;
}

export interface QualityAssetLoaderPort {
  setTextureTierCap(cap: TextureQualityCap): void;
}

export interface QualityVisualSystemPort {
  setModelThresholdScale(scale: number): void;
}

export interface QualityRelativisticVisualPort {
  setQualityEnabled(enabled: boolean): void;
}

export interface RenderQualityControllerOptions {
  readonly assetLoader: QualityAssetLoaderPort;
  readonly pipeline: QualityPostPipelinePort;
  readonly postProcessingAvailable: boolean;
  readonly proceduralSun: QualityProceduralPort;
  readonly renderer: WebGLRenderer;
  readonly relativisticVisuals: QualityRelativisticVisualPort;
  readonly starfield: QualityStarfieldPort;
  readonly visualSystem: QualityVisualSystemPort;
}

/** Applies rare governor changes to setup-owned render resources. */
export class RenderQualityController implements RenderQualityApplicationPort {
  private readonly assetLoader: QualityAssetLoaderPort;
  private readonly basePixelRatio: number;
  private readonly pipeline: QualityPostPipelinePort;
  private readonly postProcessingAvailable: boolean;
  private readonly proceduralSun: QualityProceduralPort;
  private readonly relativisticVisuals: QualityRelativisticVisualPort;
  private readonly starfield: QualityStarfieldPort;
  private readonly visualSystem: QualityVisualSystemPort;
  private appliedRung = -1;

  constructor(options: RenderQualityControllerOptions) {
    this.assetLoader = options.assetLoader;
    this.pipeline = options.pipeline;
    this.postProcessingAvailable = options.postProcessingAvailable;
    this.proceduralSun = options.proceduralSun;
    this.relativisticVisuals = options.relativisticVisuals;
    this.starfield = options.starfield;
    this.visualSystem = options.visualSystem;
    this.basePixelRatio = options.renderer.getPixelRatio();
    if (!Number.isFinite(this.basePixelRatio) || this.basePixelRatio <= 0) {
      throw new RangeError('Startup renderer pixel ratio must be positive and finite.');
    }
  }

  apply(profile: RenderQualityProfile): void {
    if (profile.rung === this.appliedRung) return;
    const effectivePixelRatio = this.basePixelRatio * profile.renderScale;
    this.pipeline.selectQuality(profile, this.postProcessingAvailable);
    this.starfield.setPixelRatio(effectivePixelRatio);
    this.starfield.setCountCap(profile.starCountCap);
    this.proceduralSun.setQuality(profile.proceduralQuality);
    this.assetLoader.setTextureTierCap(profile.textureCap);
    this.visualSystem.setModelThresholdScale(profile.modelThresholdScale);
    this.relativisticVisuals.setQualityEnabled(this.postProcessingAvailable && profile.tier >= 3);
    this.appliedRung = profile.rung;
  }
}
