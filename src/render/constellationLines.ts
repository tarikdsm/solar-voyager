import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  LessEqualDepth,
  LineSegments,
  ShaderMaterial,
  StaticDrawUsage,
  Vector3,
} from 'three';

import type { ConstellationLineCatalog } from './constellationCatalog.js';
import { SKY_RADIUS_KM } from './milkyWaySky.js';
import type { RelativisticVisualState } from './relativisticVisualState.js';
import {
  SKY_ABERRATION_GLSL,
  createSkyAberrationUniforms,
  writeSkyAberrationUniforms,
} from './skyAberration.js';
import { STAR_STRIDE_FLOATS, type StarCatalog } from './starCatalog.js';

/** Faint enough to read as a chart overlay rather than as sky content. */
export const CONSTELLATION_LINE_OPACITY = 0.22;
export const CONSTELLATION_LINE_COLOR = Object.freeze([0.52, 0.66, 0.85] as const);

/**
 * Preallocated segment capacity.
 *
 * `tools/bake_constellations.py` emits 657 segments for the 88 IAU figures. The
 * buffer is sized once at setup so the payload can arrive after the space phase
 * activates without a runtime geometry allocation; `parseConstellationLines`
 * refuses anything larger, so the cap is a contract, not a hope.
 */
export const CONSTELLATION_MAX_SEGMENTS = 1_024;

export type ConstellationCatalogLoader = () => Promise<ConstellationLineCatalog | null>;

export type ConstellationLoadState = 'idle' | 'loading' | 'ready' | 'failed';

const vertexShader = /* glsl */ `
  uniform float uRadiusKm;

  ${SKY_ABERRATION_GLSL}

  void main() {
    vec3 observedDirection = aberrateDirection(normalize(position));
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
  uniform vec3 uLineColor;
  uniform float uLineOpacity;

  void main() {
    gl_FragColor = vec4(uLineColor, uLineOpacity);
  }
`;

/**
 * The 88 IAU constellation figures as a single `LineSegments` batch.
 *
 * One draw call, one preallocated buffer, no per-constellation objects: the
 * overlay is off by default and must cost nothing when it is. Endpoints are
 * catalog star directions aberrated through the shared sky path, so the figures
 * stay welded to their own stars at any beta.
 *
 * Known approximation: each segment is one straight primitive, so at high beta a
 * long figure line bows slightly away from the aberrated great circle its
 * endpoints sit on. The median segment is 4.9 deg and the longest 24.4 deg;
 * subdividing would double a buffer nobody flies by.
 */
export class ConstellationLines {
  readonly lines: LineSegments<BufferGeometry, ShaderMaterial>;

  private readonly starCatalog: StarCatalog;
  private readonly positions: Float32Array;
  private readonly loader: ConstellationCatalogLoader | null;
  private lazyLoadingEnabled: boolean;
  private loadState: ConstellationLoadState = 'idle';
  private requestedEnabled = false;
  private segments = 0;

  constructor(
    starCatalog: StarCatalog,
    options: {
      readonly loader?: ConstellationCatalogLoader;
      readonly lazyLoadingEnabled?: boolean;
    } = {},
  ) {
    this.starCatalog = starCatalog;
    this.loader = options.loader ?? null;
    this.lazyLoadingEnabled = options.lazyLoadingEnabled ?? false;
    this.positions = new Float32Array(CONSTELLATION_MAX_SEGMENTS * 2 * 3);

    const geometry = new BufferGeometry();
    // Seeded with two real catalog directions so the warm-up primitive below is
    // a valid line rather than a degenerate one at the origin, whose normalize()
    // would be NaN.
    for (let component = 0; component < 6; component += 1) {
      this.positions[component] = starCatalog.data[component % STAR_STRIDE_FLOATS] as number;
    }
    const attribute = new BufferAttribute(this.positions, 3);
    attribute.setUsage(StaticDrawUsage);
    geometry.setAttribute('position', attribute);
    geometry.setDrawRange(0, 0);

    const material = new ShaderMaterial({
      name: 'SolarVoyagerConstellationLines',
      uniforms: {
        uRadiusKm: { value: SKY_RADIUS_KM },
        uLineColor: {
          value: new Vector3(
            CONSTELLATION_LINE_COLOR[0],
            CONSTELLATION_LINE_COLOR[1],
            CONSTELLATION_LINE_COLOR[2],
          ),
        },
        uLineOpacity: { value: CONSTELLATION_LINE_OPACITY },
        ...createSkyAberrationUniforms(),
      },
      vertexShader,
      fragmentShader,
      transparent: true,
      blending: AdditiveBlending,
      depthTest: true,
      depthFunc: LessEqualDepth,
      depthWrite: false,
      toneMapped: false,
    });

    this.lines = new LineSegments(geometry, material);
    this.lines.name = 'constellationLines';
    this.lines.matrixAutoUpdate = false;
    this.lines.frustumCulled = false;
    this.lines.visible = false;
    this.lines.updateMatrix();
  }

  /** Fills the preallocated buffer from a parsed payload. Setup or post-activation. */
  adopt(catalog: ConstellationLineCatalog): void {
    if (catalog.segmentCount > CONSTELLATION_MAX_SEGMENTS) {
      throw new RangeError(
        `constellation payload has ${catalog.segmentCount} segments; capacity is ${CONSTELLATION_MAX_SEGMENTS}`,
      );
    }
    const vertexCount = catalog.segmentCount * 2;
    for (let vertex = 0; vertex < vertexCount; vertex += 1) {
      const source = (catalog.starIndices[vertex] as number) * STAR_STRIDE_FLOATS;
      const target = vertex * 3;
      this.positions[target] = this.starCatalog.data[source] as number;
      this.positions[target + 1] = this.starCatalog.data[source + 1] as number;
      this.positions[target + 2] = this.starCatalog.data[source + 2] as number;
    }
    this.segments = catalog.segmentCount;
    this.lines.geometry.getAttribute('position').needsUpdate = true;
    this.lines.geometry.setDrawRange(0, vertexCount);
    this.loadState = 'ready';
    this.applyVisibility();
  }

  /** Allows the payload fetch once the space phase owns the frame loop. */
  enableLazyLoading(): void {
    this.lazyLoadingEnabled = true;
    this.requestCatalog();
  }

  setEnabled(enabled: boolean): void {
    this.requestedEnabled = enabled;
    this.applyVisibility();
    this.requestCatalog();
  }

  get enabled(): boolean {
    return this.requestedEnabled;
  }

  get segmentCount(): number {
    return this.segments;
  }

  get state(): ConstellationLoadState {
    return this.loadState;
  }

  /**
   * Forces the batch visible for the setup warm-up pass.
   *
   * The compile pass only reaches visible objects, and the overlay ships off, so
   * without this its program would compile on the first frame a player enables
   * it. Mirrors `OsculatingConicOverlay`'s treatment.
   */
  prepareCompilationPass(): void {
    this.lines.geometry.setDrawRange(0, 2);
    this.lines.visible = true;
  }

  /** Undoes {@link prepareCompilationPass}. */
  hide(): void {
    this.lines.geometry.setDrawRange(0, this.segments * 2);
    this.applyVisibility();
  }

  setRelativisticObserver(state: Readonly<RelativisticVisualState>): void {
    writeSkyAberrationUniforms(this.lines.material.uniforms, state);
  }

  dispose(): void {
    this.lines.geometry.dispose();
    this.lines.material.dispose();
  }

  private applyVisibility(): void {
    this.lines.visible = this.requestedEnabled && this.segments > 0;
  }

  private requestCatalog(): void {
    if (
      this.loader === null ||
      !this.lazyLoadingEnabled ||
      !this.requestedEnabled ||
      this.loadState !== 'idle'
    ) {
      return;
    }
    this.loadState = 'loading';
    void this.loader()
      .then((catalog) => {
        if (catalog === null) {
          this.loadState = 'failed';
          return;
        }
        this.adopt(catalog);
      })
      .catch(() => {
        this.loadState = 'failed';
      });
  }
}
