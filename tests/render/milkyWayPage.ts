import { WebGLRenderer } from 'three';

import constellationLinesUrl from '../../data/constellations.bin?url';
import starCatalogUrl from '../../data/stars.bin?url';
import {
  ECLIPTIC_J2000_TO_GALACTIC_ROW_MAJOR,
  galacticLatitudeRad,
  galacticLongitudeRad,
} from '../../src/core/galacticFrame.js';
import { loadAssetManifest } from '../../src/render/assetManifest.js';
import { BodyAssetLoader } from '../../src/render/bodyAssetLoader.js';
import { loadConstellationLines } from '../../src/render/constellationCatalog.js';
import { ConstellationLines } from '../../src/render/constellationLines.js';
import { MilkyWaySky, SKY_RADIUS_KM } from '../../src/render/milkyWaySky.js';
import type { SkyboxQualityTier } from '../../src/render/perfGovernor.js';
import { createRelativisticVisualState } from '../../src/render/relativisticVisualState.js';
import { CameraRelativeSpaceScene } from '../../src/render/spaceScene.js';
import { STAR_STRIDE_FLOATS, loadStarCatalog } from '../../src/render/starCatalog.js';
import { Starfield } from '../../src/render/starfield.js';
import { DISPLAY_REFERENCE_WHITE_NITS } from '../../src/render/zodiacalLight.js';

const VIEWPORT_SIZE = 384;
const FIELD_OF_VIEW_DEG = 60;
const SUN_POSITION_KM = new Float64Array([0, 0, 0]);

/**
 * Reference stars, by index into `data/stars.bin`.
 *
 * The first three are the trio the galactic rotation is proved against in
 * `src/core/galacticFrame.test.ts`. The last three sit in the bright Cygnus,
 * Crux and Scorpius stretches of the galactic plane, where the panorama carries
 * real signal rather than near-black background — those are the samples the
 * aberration-coherence comparison can actually resolve.
 */
const REFERENCE_STARS = [
  { name: 'Sirius', index: 2_484 },
  { name: 'Canopus', index: 2_320 },
  { name: 'Vega', index: 6_989 },
  { name: 'Deneb', index: 7_910 },
  { name: 'Acrux', index: 4_720 },
  { name: 'Shaula', index: 6_515 },
] as const;

export interface SkySample {
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly onScreen: boolean;
  /** Mean sky luminance in a 3x3 box at screen centre, with the star aimed at. */
  readonly luminance: number;
  readonly red: number;
  readonly green: number;
  readonly blue: number;
  readonly galacticLongitudeDeg: number;
  readonly galacticLatitudeDeg: number;
}

export interface SkySnapshot {
  readonly beta: number;
  readonly drawCalls: number;
  readonly triangles: number;
  readonly glError: number;
  readonly meanLuminance: number;
  readonly maxLuminance: number;
  readonly samples: readonly SkySample[];
}

interface MilkyWayHarness {
  ready(): Promise<void>;
  diagnostics(): {
    readonly panoramaLoadState: string;
    readonly panoramaResident: boolean;
    readonly skyboxTier: string;
    readonly skyVisible: boolean;
    readonly segmentCount: number;
    readonly starCount: number;
  };
  setLayers(options: {
    readonly panorama?: boolean;
    readonly zodiacal?: boolean;
    readonly constellations?: boolean;
    readonly stars?: boolean;
  }): void;
  setTier(tier: SkyboxQualityTier): Promise<void>;
  /** Places the observer at `distanceAu` from the Sun along +X. */
  setHeliocentricDistanceAu(distanceAu: number): void;
  render(beta: number): SkySnapshot;
  zodiacalPeakNits(): number;
}

declare global {
  var __milkyWayHarness: MilkyWayHarness | undefined;
}

const canvas = document.querySelector('#milky-way-canvas');
if (!(canvas instanceof HTMLCanvasElement)) throw new Error('Milky Way canvas is missing.');

const renderer = new WebGLRenderer({ canvas, antialias: false, alpha: false });
renderer.setPixelRatio(1);
renderer.setSize(VIEWPORT_SIZE, VIEWPORT_SIZE, false);
renderer.setClearColor(0x000000, 1);

const catalog = await loadStarCatalog(starCatalogUrl);
const starfield = new Starfield(catalog, 1);
const assetLoader = new BodyAssetLoader(
  renderer,
  await loadAssetManifest(`${import.meta.env.BASE_URL}assets/manifest.json`),
);

// The observer sits on +X so the Sun, at the origin, is always behind the camera
// when it looks along -X; that keeps the zodiacal elongation term well defined.
const cameraPositionKm = { x: 0, y: 0, z: 0 };
const positionsKm = new Float64Array(SUN_POSITION_KM);
const milkyWaySky = new MilkyWaySky({
  positionsKm,
  sunPositionOffset: 0,
  loader: { loadSkyPanorama: async (tier) => assetLoader.loadSkyPanorama('milkyway', tier) },
});
const constellationLines = new ConstellationLines(catalog, {
  loader: async () => loadConstellationLines(constellationLinesUrl, catalog.starCount),
});

const spaceScene = new CameraRelativeSpaceScene();
spaceScene.scene.add(milkyWaySky.mesh);
spaceScene.scene.add(starfield.points);
spaceScene.scene.add(constellationLines.lines);
spaceScene.camera.aspect = 1;
spaceScene.camera.fov = FIELD_OF_VIEW_DEG;
spaceScene.camera.updateProjectionMatrix();

const observerState = createRelativisticVisualState();
const galactic = new Float64Array(3);
const pixels = new Uint8Array(VIEWPORT_SIZE * VIEWPORT_SIZE * 4);

function starDirection(index: number, out: Float64Array): void {
  const offset = index * STAR_STRIDE_FLOATS;
  const x = catalog.data[offset] as number;
  const y = catalog.data[offset + 1] as number;
  const z = catalog.data[offset + 2] as number;
  const length = Math.hypot(x, y, z);
  out[0] = x / length;
  out[1] = y / length;
  out[2] = z / length;
}

/**
 * The CPU twin of `SKY_ABERRATION_GLSL`.
 *
 * Deliberately written out here rather than imported: the harness must be able
 * to disagree with the shader. If the two ever diverge, the sampled panorama
 * colour stops tracking the projected star and this gate fails, which is exactly
 * the failure the task is guarding against.
 */
function aberrate(direction: Float64Array, out: Float64Array): void {
  const betaX = observerState.betaX;
  const betaY = observerState.betaY;
  const betaZ = observerState.betaZ;
  const betaSquared = betaX * betaX + betaY * betaY + betaZ * betaZ;
  if (observerState.activation === 0 || betaSquared === 0) {
    out.set(direction);
    return;
  }
  const gamma = observerState.gamma;
  const betaDotDirection =
    betaX * (direction[0] as number) +
    betaY * (direction[1] as number) +
    betaZ * (direction[2] as number);
  const boost = ((gamma - 1) / betaSquared) * betaDotDirection + gamma;
  const scale = 1 / (gamma * (1 + betaDotDirection));
  const x = ((direction[0] as number) + boost * betaX) * scale;
  const y = ((direction[1] as number) + boost * betaY) * scale;
  const z = ((direction[2] as number) + boost * betaZ) * scale;
  const length = Math.hypot(x, y, z);
  out[0] = x / length;
  out[1] = y / length;
  out[2] = z / length;
}

const trueDirection = new Float64Array(3);
const observedDirection = new Float64Array(3);

function sampleCentrePatch(): { r: number; g: number; b: number } {
  const centre = VIEWPORT_SIZE / 2;
  let red = 0;
  let green = 0;
  let blue = 0;
  let count = 0;
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      // WebGL reads bottom-up; the patch is symmetric so only the index matters.
      const index = ((centre + dy) * VIEWPORT_SIZE + (centre + dx)) * 4;
      red += pixels[index] as number;
      green += pixels[index + 1] as number;
      blue += pixels[index + 2] as number;
      count += 1;
    }
  }
  return { r: red / count, g: green / count, b: blue / count };
}

function readPixels(): void {
  const context = renderer.getContext();
  context.readPixels(
    0,
    0,
    VIEWPORT_SIZE,
    VIEWPORT_SIZE,
    context.RGBA,
    context.UNSIGNED_BYTE,
    pixels,
  );
}

/**
 * Aims the camera at where the given direction is *observed* to be.
 *
 * This is what makes the coherence check exact: with the star pinned to screen
 * centre at every beta, the panorama texel under the crosshair is the texel
 * whose own true direction is the star's — but only if the sphere is displaced
 * by the same map the star Points are.
 */
function aimAt(direction: Float64Array): void {
  aberrate(direction, observedDirection);
  spaceScene.camera.lookAt(
    (observedDirection[0] as number) * SKY_RADIUS_KM,
    (observedDirection[1] as number) * SKY_RADIUS_KM,
    (observedDirection[2] as number) * SKY_RADIUS_KM,
  );
  // CameraRelativeSpaceScene turns matrixAutoUpdate off, so lookAt's quaternion
  // has to be composed into the matrix by hand or the camera never turns.
  spaceScene.camera.updateMatrix();
  spaceScene.camera.updateMatrixWorld(true);
}

function galacticDegreesOf(direction: Float64Array): {
  longitudeDeg: number;
  latitudeDeg: number;
} {
  const matrix = ECLIPTIC_J2000_TO_GALACTIC_ROW_MAJOR;
  for (let row = 0; row < 3; row += 1) {
    galactic[row] =
      (matrix[row * 3] as number) * (direction[0] as number) +
      (matrix[row * 3 + 1] as number) * (direction[1] as number) +
      (matrix[row * 3 + 2] as number) * (direction[2] as number);
  }
  const x = galactic[0] as number;
  const y = galactic[1] as number;
  const z = galactic[2] as number;
  return {
    longitudeDeg: (galacticLongitudeRad(x, y) * 180) / Math.PI,
    latitudeDeg: (galacticLatitudeRad(x, y, z) * 180) / Math.PI,
  };
}

function setObserver(beta: number): void {
  observerState.betaX = beta;
  observerState.betaY = 0;
  observerState.betaZ = 0;
  observerState.gamma = 1 / Math.sqrt(1 - beta * beta);
  observerState.activation = beta === 0 ? 0 : 1;
  milkyWaySky.setRelativisticObserver(observerState);
  starfield.setRelativisticObserver(observerState);
  constellationLines.setRelativisticObserver(observerState);
  milkyWaySky.update(cameraPositionKm);
}

globalThis.__milkyWayHarness = {
  async ready(): Promise<void> {
    milkyWaySky.enableLazyLoading();
    constellationLines.setEnabled(true);
    constellationLines.enableLazyLoading();
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const state = milkyWaySky.diagnostics.panoramaLoadState;
      if (state !== 'idle' && state !== 'loading' && constellationLines.state !== 'loading') break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    constellationLines.setEnabled(false);
    await renderer.compileAsync(spaceScene.scene, spaceScene.camera);
  },

  diagnostics() {
    return {
      panoramaLoadState: milkyWaySky.diagnostics.panoramaLoadState,
      panoramaResident: milkyWaySky.diagnostics.panoramaResident,
      skyboxTier: milkyWaySky.diagnostics.skyboxTier,
      skyVisible: milkyWaySky.diagnostics.visible,
      segmentCount: constellationLines.segmentCount,
      starCount: catalog.starCount,
    };
  },

  setLayers(options) {
    if (options.panorama !== undefined) milkyWaySky.setPanoramaEnabled(options.panorama);
    if (options.zodiacal !== undefined) milkyWaySky.setZodiacalLightEnabled(options.zodiacal);
    if (options.constellations !== undefined) constellationLines.setEnabled(options.constellations);
    if (options.stars !== undefined) starfield.points.visible = options.stars;
  },

  async setTier(tier) {
    milkyWaySky.setSkyboxTier(tier);
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if (milkyWaySky.diagnostics.panoramaLoadState !== 'loading') break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  },

  setHeliocentricDistanceAu(distanceAu) {
    cameraPositionKm.x = distanceAu * 149_597_870.7;
    milkyWaySky.update(cameraPositionKm);
  },

  zodiacalPeakNits() {
    return milkyWaySky.diagnostics.zodiacalPeakNits * DISPLAY_REFERENCE_WHITE_NITS;
  },

  render(beta: number): SkySnapshot {
    setObserver(beta);
    // Frame-wide statistics are taken looking at the galactic centre.
    const matrix = ECLIPTIC_J2000_TO_GALACTIC_ROW_MAJOR;
    trueDirection[0] = matrix[0] as number;
    trueDirection[1] = matrix[3] as number;
    trueDirection[2] = matrix[6] as number;
    aimAt(trueDirection);

    renderer.info.reset();
    renderer.render(spaceScene.scene, spaceScene.camera);
    readPixels();

    let total = 0;
    let maximum = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      const luminance =
        0.2126 * (pixels[index] as number) +
        0.7152 * (pixels[index + 1] as number) +
        0.0722 * (pixels[index + 2] as number);
      total += luminance;
      if (luminance > maximum) maximum = luminance;
    }
    const drawCalls = renderer.info.render.calls;
    const triangles = renderer.info.render.triangles;
    const glError = renderer.getContext().getError();

    const samples: SkySample[] = [];
    for (const star of REFERENCE_STARS) {
      starDirection(star.index, trueDirection);
      const { longitudeDeg, latitudeDeg } = galacticDegreesOf(trueDirection);
      aimAt(trueDirection);
      renderer.render(spaceScene.scene, spaceScene.camera);
      readPixels();
      const patch = sampleCentrePatch();
      samples.push({
        name: star.name,
        x: VIEWPORT_SIZE / 2,
        y: VIEWPORT_SIZE / 2,
        onScreen: true,
        luminance: 0.2126 * patch.r + 0.7152 * patch.g + 0.0722 * patch.b,
        red: patch.r,
        green: patch.g,
        blue: patch.b,
        galacticLongitudeDeg: longitudeDeg,
        galacticLatitudeDeg: latitudeDeg,
      });
    }

    return {
      beta,
      drawCalls,
      triangles,
      glError,
      meanLuminance: total / (VIEWPORT_SIZE * VIEWPORT_SIZE),
      maxLuminance: maximum,
      samples,
    };
  },
};
