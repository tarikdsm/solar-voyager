import {
  Mesh,
  MeshBasicMaterial,
  SphereGeometry,
  Vector3,
  WebGLRenderTarget,
  WebGLRenderer,
} from 'three';

import starCatalogUrl from '../../data/stars.bin?url';
import type { ReadonlyVec3 } from '../../src/core/vec3.js';
import { CameraRelativeSpaceScene } from '../../src/render/spaceScene.js';
import { loadStarCatalog } from '../../src/render/starCatalog.js';
import {
  STARFIELD_RADIUS_KM,
  Starfield,
  createMagnitudeOrderedStarIndices,
} from '../../src/render/starfield.js';

const VIEWPORT_SIZE = 384;
const SAMPLE_RADIUS_PX = 4;
const ALNILAM_INDEX = 1897;
const ORION_STARS = [
  { name: 'Rigel', index: 1708 },
  { name: 'Bellatrix', index: 1785 },
  { name: 'Mintaka', index: 1846 },
  { name: 'Alnilam', index: 1897 },
  { name: 'Alnitak', index: 1942 },
  { name: 'Saiph', index: 1998 },
  { name: 'Betelgeuse', index: 2055 },
] as const;

interface StarSample {
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly litPixels: number;
  readonly peakRgb: number;
  readonly peakX: number | null;
  readonly peakY: number | null;
}

interface StarfieldSnapshot {
  readonly depthMode: 'logarithmic' | 'reversed';
  readonly reversedDepthBuffer: boolean;
  readonly fovDegrees: number;
  readonly frameHash: number;
  readonly totalLitPixels: number;
  readonly drawCalls: number;
  readonly glError: number;
  readonly samples: readonly StarSample[];
}

interface StarfieldHarness {
  render(fovDegrees: number, cameraPositionKm: ReadonlyVec3): StarfieldSnapshot;
  renderDarkControl(): StarfieldSnapshot;
  renderOcclusionControl(): StarfieldSnapshot;
  renderIsolatedOrion(): readonly StarSample[];
}

declare global {
  var __starfieldHarness: StarfieldHarness | undefined;
}

const canvas = document.querySelector('#starfield-canvas');
if (!(canvas instanceof HTMLCanvasElement)) throw new Error('Starfield canvas is missing.');

const depthMode = new URLSearchParams(globalThis.location.search).get('depth');
const requestedDepthMode = depthMode === 'reversed' ? 'reversed' : 'logarithmic';
const renderer = new WebGLRenderer({
  canvas,
  antialias: false,
  alpha: false,
  logarithmicDepthBuffer: requestedDepthMode === 'logarithmic',
  reversedDepthBuffer: requestedDepthMode === 'reversed',
});
renderer.setPixelRatio(1);
renderer.setSize(VIEWPORT_SIZE, VIEWPORT_SIZE, false);
renderer.setClearColor(0x000000, 1);

const catalog = await loadStarCatalog(starCatalogUrl);
const starfield = new Starfield(catalog, renderer.getPixelRatio());
const drawOffsetByCatalogIndex = new Uint32Array(catalog.starCount);
const magnitudeOrder = createMagnitudeOrderedStarIndices(catalog);
for (let drawOffset = 0; drawOffset < magnitudeOrder.length; drawOffset += 1) {
  const catalogIndex = magnitudeOrder[drawOffset];
  if (catalogIndex !== undefined) drawOffsetByCatalogIndex[catalogIndex] = drawOffset;
}
const spaceScene = new CameraRelativeSpaceScene();
spaceScene.scene.add(starfield.points);
spaceScene.camera.aspect = 1;

const alnilamOffset = ALNILAM_INDEX * catalog.strideFloats;
const occluder = new Mesh(
  new SphereGeometry(50_000, 16, 8),
  new MeshBasicMaterial({ color: 0x000000 }),
);
occluder.position
  .set(
    catalog.data[alnilamOffset] as number,
    catalog.data[alnilamOffset + 1] as number,
    catalog.data[alnilamOffset + 2] as number,
  )
  .multiplyScalar(1e6);
occluder.matrixAutoUpdate = false;
occluder.updateMatrix();
occluder.visible = false;
spaceScene.scene.add(occluder);

const orionCenter = new Vector3();
for (const star of ORION_STARS) {
  const offset = star.index * catalog.strideFloats;
  orionCenter.x += catalog.data[offset] as number;
  orionCenter.y += catalog.data[offset + 1] as number;
  orionCenter.z += catalog.data[offset + 2] as number;
}
orionCenter.normalize();
spaceScene.camera.lookAt(orionCenter);
spaceScene.camera.updateMatrix();
await renderer.compileAsync(spaceScene.scene, spaceScene.camera);

const renderTarget = new WebGLRenderTarget(VIEWPORT_SIZE, VIEWPORT_SIZE);
const pixels = new Uint8Array(VIEWPORT_SIZE * VIEWPORT_SIZE * 4);
const projectedPosition = new Vector3();

function hashPixels(): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < pixels.length; index += 1) {
    hash ^= pixels[index] as number;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function sampleStar(name: string, index: number): StarSample {
  const offset = index * catalog.strideFloats;
  projectedPosition
    .set(
      catalog.data[offset] as number,
      catalog.data[offset + 1] as number,
      catalog.data[offset + 2] as number,
    )
    .multiplyScalar(STARFIELD_RADIUS_KM)
    .project(spaceScene.camera);
  const x = (projectedPosition.x * 0.5 + 0.5) * VIEWPORT_SIZE;
  const y = (projectedPosition.y * 0.5 + 0.5) * VIEWPORT_SIZE;
  const centerX = Math.round(x);
  const centerY = Math.round(y);
  let litPixels = 0;
  let peakRgb = 0;
  let peakX: number | null = null;
  let peakY: number | null = null;
  for (
    let sampleY = centerY - SAMPLE_RADIUS_PX;
    sampleY <= centerY + SAMPLE_RADIUS_PX;
    sampleY += 1
  ) {
    if (sampleY < 0 || sampleY >= VIEWPORT_SIZE) continue;
    for (
      let sampleX = centerX - SAMPLE_RADIUS_PX;
      sampleX <= centerX + SAMPLE_RADIUS_PX;
      sampleX += 1
    ) {
      if (sampleX < 0 || sampleX >= VIEWPORT_SIZE) continue;
      const pixelOffset = (sampleY * VIEWPORT_SIZE + sampleX) * 4;
      const rgb =
        (pixels[pixelOffset] as number) +
        (pixels[pixelOffset + 1] as number) +
        (pixels[pixelOffset + 2] as number);
      if (rgb > 0) litPixels += 1;
      if (rgb > peakRgb) {
        peakRgb = rgb;
        peakX = sampleX;
        peakY = sampleY;
      }
    }
  }
  return { name, x, y, litPixels, peakRgb, peakX, peakY };
}

function renderSnapshot(fovDegrees: number, cameraPositionKm: ReadonlyVec3): StarfieldSnapshot {
  spaceScene.camera.fov = fovDegrees;
  spaceScene.camera.updateProjectionMatrix();
  spaceScene.updateCameraRelative(cameraPositionKm);
  renderer.info.reset();
  renderer.setRenderTarget(renderTarget);
  renderer.clear();
  renderer.render(spaceScene.scene, spaceScene.camera);
  renderer.readRenderTargetPixels(renderTarget, 0, 0, VIEWPORT_SIZE, VIEWPORT_SIZE, pixels);
  renderer.setRenderTarget(null);

  let totalLitPixels = 0;
  for (let offset = 0; offset < pixels.length; offset += 4) {
    if (
      (pixels[offset] as number) + (pixels[offset + 1] as number) + (pixels[offset + 2] as number) >
      0
    ) {
      totalLitPixels += 1;
    }
  }

  return {
    depthMode: requestedDepthMode,
    reversedDepthBuffer: renderer.capabilities.reversedDepthBuffer,
    fovDegrees,
    frameHash: hashPixels(),
    totalLitPixels,
    drawCalls: renderer.info.render.calls,
    glError: renderer.getContext().getError(),
    samples: ORION_STARS.map((star) => sampleStar(star.name, star.index)),
  };
}

const origin = { x: 0, y: 0, z: 0 };
globalThis.__starfieldHarness = {
  render: renderSnapshot,
  renderDarkControl() {
    starfield.points.visible = false;
    const snapshot = renderSnapshot(60, origin);
    starfield.points.visible = true;
    return snapshot;
  },
  renderOcclusionControl() {
    occluder.visible = true;
    const snapshot = renderSnapshot(60, origin);
    occluder.visible = false;
    return snapshot;
  },
  renderIsolatedOrion() {
    const samples: StarSample[] = [];
    try {
      for (const star of ORION_STARS) {
        starfield.points.geometry.setDrawRange(drawOffsetByCatalogIndex[star.index] as number, 1);
        const snapshot = renderSnapshot(60, origin);
        const sample = snapshot.samples.find((candidate) => candidate.name === star.name);
        if (sample === undefined) throw new Error(`Missing isolated ${star.name} sample.`);
        samples.push(sample);
      }
    } finally {
      starfield.points.geometry.setDrawRange(0, catalog.starCount);
    }
    return samples;
  },
};
