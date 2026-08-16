import {
  BackSide,
  ClampToEdgeWrapping,
  LessEqualDepth,
  LinearFilter,
  Matrix3,
  Mesh,
  RepeatWrapping,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
  type Texture,
} from 'three';

import { ECLIPTIC_J2000_TO_GALACTIC_ROW_MAJOR } from '../core/galacticFrame.js';
import type { ReadonlyVec3 } from '../core/vec3.js';
import {
  createEffectBindingDegradeState,
  degradeEffectBinding,
  restoreEffectBinding,
  type EffectBindingDegradeState,
  type EffectBindingTelemetry,
  type EffectBindingWarner,
} from './effectBindingGuard.js';
import type { SkyboxQualityTier } from './perfGovernor.js';
import type { RelativisticVisualState } from './relativisticVisualState.js';
import {
  SKY_ABERRATION_GLSL,
  createSkyAberrationUniforms,
  writeSkyAberrationUniforms,
} from './skyAberration.js';
import { STARFIELD_RADIUS_KM } from './starfield.js';
import { ZODIACAL_COLOR, ZODIACAL_LIGHT_GLSL, zodiacalLightScale } from './zodiacalLight.js';

/** The panorama sits on the same shell as the star Points, by construction. */
export const SKY_RADIUS_KM = STARFIELD_RADIUS_KM;

/**
 * Display scale applied to the panorama texels.
 *
 * The ESO source is stretched for print. Undimmed it drowns the 9,096 real
 * catalog stars, which are the honest part of the sky; this factor puts the
 * brightest galactic-plane texels just under the faintest catalog stars.
 */
export const PANORAMA_DISPLAY_INTENSITY = 0.35;

/** Sphere tessellation: 3,968 triangles, inside the workload golden's headroom. */
export const SKY_WIDTH_SEGMENTS = 64;
export const SKY_HEIGHT_SEGMENTS = 32;

export type SkyPanoramaLoadState = 'idle' | 'loading' | 'ready' | 'failed';

/** Lazy, failure-stable panorama source; `null` means "not available, carry on". */
export interface SkyPanoramaLoader {
  loadSkyPanorama(tier: SkyboxQualityTier): Promise<Texture | null>;
}

export interface MilkyWaySkyOptions {
  readonly positionsKm: Float64Array;
  readonly sunPositionOffset: number;
  readonly loader?: SkyPanoramaLoader;
  readonly lazyLoadingEnabled?: boolean;
  /**
   * The scene's T0129 effect-binding telemetry, so a degraded sky is visible in
   * the same counters as a degraded plume or marker. Omit only in unit tests.
   */
  readonly effectBindingTelemetry?: EffectBindingTelemetry;
  readonly onEffectBindingWarning?: EffectBindingWarner;
}

export interface MilkyWaySkyDiagnostics {
  readonly panoramaLoadState: SkyPanoramaLoadState;
  readonly panoramaEnabled: boolean;
  readonly panoramaResident: boolean;
  readonly zodiacalLightEnabled: boolean;
  readonly zodiacalPeakNits: number;
  readonly skyboxTier: SkyboxQualityTier;
  readonly visible: boolean;
  readonly heliocentricDistanceKm: number;
  /** T0129 degrade path: true while the solar direction cannot be derived. */
  readonly observerDegraded: boolean;
}

const vertexShader = /* glsl */ `
  uniform float uRadiusKm;
  uniform mat3 uGalacticFromEcliptic;

  varying vec3 vGalacticDirection;
  varying vec3 vEclipticDirection;

  ${SKY_ABERRATION_GLSL}

  void main() {
    vec3 direction = normalize(position);
    // The texture is sampled from the UNaberrated direction and the vertex is
    // placed at the aberrated one, which is exactly what the star Points do: a
    // texel that truly lies at direction d lands on screen at aberrate(d).
    vEclipticDirection = direction;
    vGalacticDirection = uGalacticFromEcliptic * direction;

    vec3 observedDirection = aberrateDirection(direction);
    vec4 viewPosition = modelViewMatrix * vec4(observedDirection * uRadiusKm, 1.0);
    vec4 clipPosition = projectionMatrix * viewPosition;
    #ifdef USE_REVERSED_DEPTH_BUFFER
      clipPosition.z = 0.0;
    #else
      clipPosition.z = clipPosition.w;
    #endif
    gl_Position = clipPosition;
  }
`;

const fragmentShader = /* glsl */ `
  uniform sampler2D uPanorama;
  uniform float uPanoramaIntensity;

  varying vec3 vGalacticDirection;
  varying vec3 vEclipticDirection;

  ${ZODIACAL_LIGHT_GLSL}

  void main() {
    vec3 galactic = normalize(vGalacticDirection);
    // rendering-spec.md section 5.1 — equirectangular in galactic coordinates,
    // longitude increasing to the left, latitude increasing upward.
    vec2 panoramaUv = vec2(
      0.5 - atan(galactic.y, galactic.x) * 0.15915494309189535,
      0.5 - asin(clamp(galactic.z, -1.0, 1.0)) * 0.3183098861837907
    );
    vec3 color = texture2D(uPanorama, panoramaUv).rgb * uPanoramaIntensity;
    color += zodiacalLight(normalize(vEclipticDirection));
    gl_FragColor = vec4(color, 1.0);
  }
`;

function assertPositionOffset(positionsKm: Float64Array, componentOffset: number): void {
  if (
    !Number.isInteger(componentOffset) ||
    componentOffset < 0 ||
    componentOffset % 3 !== 0 ||
    componentOffset + 2 >= positionsKm.length
  ) {
    throw new RangeError('Milky Way sky offset must address one complete xyz triple.');
  }
}

/**
 * The panorama sphere and the zodiacal band, in one setup-time draw.
 *
 * Both live in one mesh on purpose: they share the aberration path, they share
 * the far-plane depth trick, and the draw-call golden has room for one sky, not
 * two. The panorama texture arrives after the space phase activates — it is
 * deliberately absent from `data/initial-path.json`, so the material ships with a
 * zero-intensity sampler and never recompiles when the real texture lands.
 */
export class MilkyWaySky {
  readonly mesh: Mesh<SphereGeometry, ShaderMaterial>;

  private readonly positionsKm: Float64Array;
  private readonly sunPositionOffset: number;
  private readonly loader: SkyPanoramaLoader | null;
  private lazyLoadingEnabled: boolean;
  private loadState: SkyPanoramaLoadState = 'idle';
  private loadedTier: SkyboxQualityTier | null = null;
  private panoramaTexture: Texture | null = null;
  private panoramaEnabled = true;
  private zodiacalLightEnabled = true;
  private skyboxTier: SkyboxQualityTier = 'full';
  private heliocentricDistanceKm = 0;
  private readonly effectBindingTelemetry: EffectBindingTelemetry | null;
  private readonly observerDegradeState: EffectBindingDegradeState;
  private readonly warnEffectBinding: EffectBindingWarner;

  constructor(options: MilkyWaySkyOptions) {
    assertPositionOffset(options.positionsKm, options.sunPositionOffset);
    this.positionsKm = options.positionsKm;
    this.sunPositionOffset = options.sunPositionOffset;
    this.loader = options.loader ?? null;
    this.lazyLoadingEnabled = options.lazyLoadingEnabled ?? false;
    this.effectBindingTelemetry = options.effectBindingTelemetry ?? null;
    this.observerDegradeState = createEffectBindingDegradeState('milkyWaySky:solarDirection');
    this.warnEffectBinding =
      options.onEffectBindingWarning ??
      ((message: string): void => {
        console.warn(message);
      });

    const galacticFromEcliptic = new Matrix3();
    const matrix = ECLIPTIC_J2000_TO_GALACTIC_ROW_MAJOR;
    galacticFromEcliptic.set(
      matrix[0] as number,
      matrix[1] as number,
      matrix[2] as number,
      matrix[3] as number,
      matrix[4] as number,
      matrix[5] as number,
      matrix[6] as number,
      matrix[7] as number,
      matrix[8] as number,
    );

    const material = new ShaderMaterial({
      name: 'SolarVoyagerMilkyWaySky',
      uniforms: {
        uRadiusKm: { value: SKY_RADIUS_KM },
        uGalacticFromEcliptic: { value: galacticFromEcliptic },
        uPanorama: { value: null },
        uPanoramaIntensity: { value: 0 },
        uSunDirection: { value: new Vector3(0, 0, 1) },
        uZodiacalScale: { value: 0 },
        uZodiacalColor: {
          value: new Vector3(ZODIACAL_COLOR[0], ZODIACAL_COLOR[1], ZODIACAL_COLOR[2]),
        },
        ...createSkyAberrationUniforms(),
      },
      vertexShader,
      fragmentShader,
      side: BackSide,
      depthTest: true,
      depthFunc: LessEqualDepth,
      depthWrite: false,
      toneMapped: false,
    });

    this.mesh = new Mesh(new SphereGeometry(1, SKY_WIDTH_SEGMENTS, SKY_HEIGHT_SEGMENTS), material);
    this.mesh.name = 'milkyWaySky';
    this.mesh.matrixAutoUpdate = false;
    this.mesh.frustumCulled = false;
    // Behind every other opaque draw, including the star Points that follow it.
    this.mesh.renderOrder = -1;
    this.mesh.updateMatrix();
  }

  /** Allows the panorama fetch once the space phase owns the frame loop. */
  enableLazyLoading(): void {
    this.lazyLoadingEnabled = true;
    this.requestPanorama();
  }

  setPanoramaEnabled(enabled: boolean): void {
    this.panoramaEnabled = enabled;
    this.applyContributions();
    this.requestPanorama();
  }

  setZodiacalLightEnabled(enabled: boolean): void {
    this.zodiacalLightEnabled = enabled;
    this.applyContributions();
  }

  /** Governor rung: which panorama resolution tier is fetched and resident. */
  setSkyboxTier(tier: SkyboxQualityTier): void {
    if (tier === this.skyboxTier) return;
    this.skyboxTier = tier;
    this.applyContributions();
    this.requestPanorama();
  }

  setRelativisticObserver(state: Readonly<RelativisticVisualState>): void {
    writeSkyAberrationUniforms(this.mesh.material.uniforms, state);
  }

  /**
   * Per-frame observer update. Allocation-free.
   *
   * The solar direction and heliocentric distance are *derived* quantities, so
   * they follow T0129's effect-binding policy rather than the hard throw ship and
   * body positions get: a non-finite source holds the last good direction, warns
   * once, and raises the scene's effect-binding telemetry. A NaN here would
   * otherwise paint the entire background with NaN fragments.
   */
  update(cameraPositionKm: ReadonlyVec3): void {
    const sunX = (this.positionsKm[this.sunPositionOffset] as number) - cameraPositionKm.x;
    const sunY = (this.positionsKm[this.sunPositionOffset + 1] as number) - cameraPositionKm.y;
    const sunZ = (this.positionsKm[this.sunPositionOffset + 2] as number) - cameraPositionKm.z;
    const distanceKm = Math.sqrt(sunX * sunX + sunY * sunY + sunZ * sunZ);

    if (!Number.isFinite(distanceKm) || distanceKm <= 0) {
      if (this.effectBindingTelemetry !== null) {
        degradeEffectBinding(
          this.effectBindingTelemetry,
          this.observerDegradeState,
          this.warnEffectBinding,
        );
      }
      return;
    }
    if (this.effectBindingTelemetry !== null) {
      restoreEffectBinding(this.effectBindingTelemetry, this.observerDegradeState);
    }

    this.heliocentricDistanceKm = distanceKm;
    const uniforms = this.mesh.material.uniforms;
    const sunDirection = uniforms.uSunDirection?.value as Vector3 | undefined;
    if (sunDirection !== undefined) {
      const inverseDistance = 1 / distanceKm;
      sunDirection.set(sunX * inverseDistance, sunY * inverseDistance, sunZ * inverseDistance);
    }
    if (uniforms.uZodiacalScale !== undefined) {
      uniforms.uZodiacalScale.value = zodiacalLightScale(this.zodiacalLightEnabled, distanceKm);
    }
  }

  get diagnostics(): MilkyWaySkyDiagnostics {
    const uniforms = this.mesh.material.uniforms;
    return {
      panoramaLoadState: this.loadState,
      panoramaEnabled: this.panoramaEnabled,
      panoramaResident: this.panoramaTexture !== null,
      zodiacalLightEnabled: this.zodiacalLightEnabled,
      zodiacalPeakNits: (uniforms.uZodiacalScale?.value as number | undefined) ?? 0,
      skyboxTier: this.skyboxTier,
      visible: this.mesh.visible,
      heliocentricDistanceKm: this.heliocentricDistanceKm,
      observerDegraded: this.observerDegradeState.degraded,
    };
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.panoramaTexture?.dispose();
    this.panoramaTexture = null;
  }

  private get panoramaActive(): boolean {
    return this.panoramaEnabled && this.skyboxTier !== 'off';
  }

  private requestPanorama(): void {
    if (
      this.loader === null ||
      !this.lazyLoadingEnabled ||
      !this.panoramaActive ||
      this.loadState === 'loading' ||
      this.loadState === 'failed' ||
      this.loadedTier === this.skyboxTier
    ) {
      return;
    }
    const requestedTier = this.skyboxTier;
    this.loadState = 'loading';
    void this.loader
      .loadSkyPanorama(requestedTier)
      .then((texture) => {
        if (texture === null) {
          this.loadState = 'failed';
          return;
        }
        this.adoptPanorama(texture, requestedTier);
      })
      .catch(() => {
        this.loadState = 'failed';
      });
  }

  private adoptPanorama(texture: Texture, tier: SkyboxQualityTier): void {
    // Equirectangular longitude wraps; latitude must not, or the poles smear
    // across the seam. Mip selection is disabled because the fragment-stage UV
    // is discontinuous at the wrap and its screen-space derivative would pick
    // the coarsest level for that one pixel column.
    texture.wrapS = RepeatWrapping;
    texture.wrapT = ClampToEdgeWrapping;
    texture.minFilter = LinearFilter;
    texture.magFilter = LinearFilter;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;

    const previous = this.panoramaTexture;
    this.panoramaTexture = texture;
    this.loadedTier = tier;
    this.loadState = 'ready';
    const uniform = this.mesh.material.uniforms.uPanorama;
    if (uniform !== undefined) uniform.value = texture;
    this.applyContributions();
    if (previous !== null && previous !== texture) previous.dispose();
  }

  private applyContributions(): void {
    const uniforms = this.mesh.material.uniforms;
    const panoramaIntensity =
      this.panoramaActive && this.panoramaTexture !== null ? PANORAMA_DISPLAY_INTENSITY : 0;
    if (uniforms.uPanoramaIntensity !== undefined) {
      uniforms.uPanoramaIntensity.value = panoramaIntensity;
    }
    // An opaque full-screen sphere that would paint nothing is skipped outright;
    // this is the fill-rate half of the governor's skybox rung.
    this.mesh.visible = panoramaIntensity > 0 || this.zodiacalLightEnabled;
  }
}
