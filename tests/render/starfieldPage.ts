import { Vector3, WebGLRenderTarget, WebGLRenderer } from 'three';

import starCatalogUrl from '../../data/stars.bin?url';
import type { ReadonlyVec3 } from '../../src/core/vec3.js';
import { CameraRelativeSpaceScene } from '../../src/render/spaceScene.js';
import { loadStarCatalog } from '../../src/render/starCatalog.js';
import { STARFIELD_RADIUS_KM, Starfield } from '../../src/render/starfield.js';

const VIEWPORT_SIZE = 384;
const SAMPLE_RADIUS_PX = 4;
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
}

interface StarfieldSnapshot {
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
}

declare global {
  var __starfieldHarness: StarfieldHarness | undefined;
}

const canvas = document.querySelector('#starfield-canvas');
if (!(canvas instanceof HTMLCanvasElement)) throw new Error('Starfield canvas is missing.');

const renderer = new WebGLRenderer({
  canvas,
  antialias: false,
  alpha: false,
  logarithmicDepthBuffer: true,
});
renderer.setPixelRatio(1);
renderer.setSize(VIEWPORT_SIZE, VIEWPORT_SIZE, false);
renderer.setClearColor(0x000000, 1);

const catalog = await loadStarCatalog(starCatalogUrl);
const starfield = new Starfield(catalog, renderer.getPixelRatio());
const spaceScene = new CameraRelativeSpaceScene();
spaceScene.scene.add(starfield.points);
spaceScene.camera.aspect = 1;

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
      peakRgb = Math.max(peakRgb, rgb);
    }
  }
  return { name, x, y, litPixels, peakRgb };
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
};
