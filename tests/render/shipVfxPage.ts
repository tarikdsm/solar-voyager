import { WebGLRenderTarget, WebGLRenderer } from 'three';

import { loadAssetManifest } from '../../src/render/assetManifest.js';
import { BodyAssetLoader } from '../../src/render/bodyAssetLoader.js';
import { BodyPointCloud } from '../../src/render/bodyPointCloud.js';
import { QUALITY_PROFILES } from '../../src/render/perfGovernor.js';
import { ShipEffects } from '../../src/render/shipEffects.js';
import { ShipVisual, SHIP_BOUNDING_RADIUS_KM } from '../../src/render/shipVisual.js';
import { SolarLighting } from '../../src/render/solarLighting.js';
import { CameraRelativeSpaceScene } from '../../src/render/spaceScene.js';
import { writeQuaternionFromForwardInto } from '../../src/sim/ship/attitude.js';

const AU_KM = 149_597_870.7;
const SOLAR_RADIUS_KM = 695_700;
const SUN_INDEX = 0;
const SHIP_INDEX = 1;
const VIEWPORT_SIZE = 256;
const VERTICAL_FOV_RAD = Math.PI / 3;
/** `P = m·alpha·c` for the default vessel at full throttle (physics-spec §5). */
const FULL_POWER_W = 10_000 * 98.0665 * 299_792_458;

interface ShipVfxSnapshot {
  readonly throttle: number;
  readonly burning: boolean;
  readonly beamLengthM: number;
  readonly beamIntensity: number;
  readonly beamSegments: number;
  readonly rcsFiring: boolean;
  readonly rcsLivePuffCount: number;
  readonly rcsLiveCapacity: number;
  readonly lightCount: number;
  readonly beaconFactor: number;
  readonly navFactor: number;
  readonly modelBound: boolean;
  readonly anchorErrorM: number;
  readonly anchorsVerified: boolean;
  readonly nonFiniteObserved: boolean;
  readonly degradedBindingCount: number;
  readonly skippedBindCount: number;
  readonly plumeMagnitude: number;
  readonly pointMagnitude: number;
  readonly cosExhaustAngle: number;
  readonly litPixels: number;
  readonly meanLuminance: number;
  readonly drawCalls: number;
  readonly triangles: number;
  readonly programCount: number;
  readonly glError: number;
}

interface ShipVfxHarness {
  awaitModel(): Promise<void>;
  step(options: {
    distanceKm: number;
    throttle: number;
    /** Body-frame pitch/yaw/roll rate, integrated into the attitude by the step. */
    bodyRateRadS: [number, number, number];
    simTimeSec: number;
    simDeltaSec: number;
    nowMs: number;
  }): ShipVfxSnapshot;
  applyRung(rung: number): void;
  farField(distanceKm: number, throttle: number): { withPlume: number; reflectedOnly: number };
  loadState(): string;
  programCount(): number;
}

declare global {
  var __shipVfxHarness: ShipVfxHarness | undefined;
}

const canvas = document.querySelector('#ship-vfx-canvas');
if (!(canvas instanceof HTMLCanvasElement)) throw new Error('Ship VFX canvas is missing.');

const renderer = new WebGLRenderer({
  canvas,
  antialias: false,
  alpha: false,
  logarithmicDepthBuffer: true,
});
renderer.setPixelRatio(1);
renderer.setSize(VIEWPORT_SIZE, VIEWPORT_SIZE, false);
renderer.setClearColor(0x000000, 1);

const spaceScene = new CameraRelativeSpaceScene();
spaceScene.camera.fov = 60;
spaceScene.camera.aspect = 1;
spaceScene.camera.updateProjectionMatrix();

// Sun at the origin, ship one astronomical unit along +X — the same photometric
// geometry `shipVisualPage.ts` uses, so the two harnesses can be compared.
const positionsKm = new Float64Array([0, 0, 0, AU_KM, 0, 0]);
const shipStateKm = new Float64Array([AU_KM, 0, 0, 0, 0, 0, 0]);
const attitudeQuaternion = new Float64Array(4);
const cameraPositionKm = { x: AU_KM, y: 0, z: 0 };
// Nose along +Y, so the exhaust leaves along -Y and the beam crosses the frame
// broadside instead of pointing at (or straight away from) the camera.
writeQuaternionFromForwardInto(attitudeQuaternion, 0, 1, 0);

const pointCloud = new BodyPointCloud(new Uint32Array([0xff_f4_d6, 0xdf_e6_ef]));
spaceScene.bindPackedPointPositions(pointCloud.points, positionsKm);
pointCloud.writeAppearance(SUN_INDEX, 0, 0, 0);
pointCloud.commitAppearance();
const lighting = new SolarLighting(
  spaceScene,
  positionsKm,
  SUN_INDEX * 3,
  SHIP_INDEX * 3,
  SOLAR_RADIUS_KM,
);

const manifest = await loadAssetManifest(`${import.meta.env.BASE_URL}assets/manifest.json`);
const assetLoader = new BodyAssetLoader(renderer, manifest);
const shipVisual = new ShipVisual({
  spaceScene,
  pointCloud,
  positionsKm,
  shipIndex: SHIP_INDEX,
  sunIndex: SUN_INDEX,
  assetLoader,
  compileModel: async (root) => {
    await renderer.compileAsync(root, spaceScene.camera, spaceScene.scene);
  },
});
const shipEffects = new ShipEffects({
  spaceScene,
  shipVisual,
  positionsKm,
  shipIndex: SHIP_INDEX,
});
shipVisual.setModelReadyObserver((modelRoot, materials) => {
  shipEffects.bindModel(modelRoot, materials);
});
shipVisual.writeState(shipStateKm, attitudeQuaternion);
shipEffects.writeState(attitudeQuaternion, 0, 0, 0, 0);

/**
 * Integrates one body-frame rate into the live attitude.
 *
 * ADR-025 body axes: `+X` nose (roll), `+Y` lateral (pitch), `+Z` up (yaw).
 */
function advanceAttitude(bodyRateRadS: readonly number[], simDeltaSec: number): void {
  const pitch = bodyRateRadS[0] ?? 0;
  const yaw = bodyRateRadS[1] ?? 0;
  const roll = bodyRateRadS[2] ?? 0;
  const magnitude = Math.hypot(pitch, yaw, roll);
  if (magnitude === 0 || simDeltaSec <= 0) return;
  const angle = magnitude * simDeltaSec;
  const sine = Math.sin(angle / 2) / magnitude;
  const deltaX = roll * sine;
  const deltaY = pitch * sine;
  const deltaZ = yaw * sine;
  const deltaW = Math.cos(angle / 2);
  const baseX = attitudeQuaternion[0] as number;
  const baseY = attitudeQuaternion[1] as number;
  const baseZ = attitudeQuaternion[2] as number;
  const baseW = attitudeQuaternion[3] as number;
  attitudeQuaternion[0] = baseW * deltaX + baseX * deltaW + baseY * deltaZ - baseZ * deltaY;
  attitudeQuaternion[1] = baseW * deltaY - baseX * deltaZ + baseY * deltaW + baseZ * deltaX;
  attitudeQuaternion[2] = baseW * deltaZ + baseX * deltaY - baseY * deltaX + baseZ * deltaW;
  attitudeQuaternion[3] = baseW * deltaW - baseX * deltaX - baseY * deltaY - baseZ * deltaZ;
}

function distanceForDiameterPx(diameterPx: number): number {
  const angularDiameterRad = (diameterPx * VERTICAL_FOV_RAD) / VIEWPORT_SIZE;
  return SHIP_BOUNDING_RADIUS_KM / Math.sin(angularDiameterRad / 2);
}

const renderTarget = new WebGLRenderTarget(VIEWPORT_SIZE, VIEWPORT_SIZE);
const pixels = new Uint8Array(VIEWPORT_SIZE * VIEWPORT_SIZE * 4);

/**
 * The whole point of `prepareCompilationPass`: every plume and puff program is
 * built here, while a loading screen would be up, so the first burn compiles
 * nothing. `programCount()` is what the gate compares before and after.
 *
 * Warmed through **both** output paths on purpose. three's program cache key
 * includes the output colour space, so a material rendered into a linear
 * `WebGLRenderTarget` gets a different program from the same material rendered
 * to the sRGB canvas. This fixture measures pixels through a render target and
 * mirrors each frame onto the canvas, so warming only one of the two would make
 * the gate report a "first-burn compile" that is an artifact of the harness
 * rather than a defect in the game. The shipped renderer has one consistent
 * path (the post pipeline), so it only ever needs one.
 */
shipEffects.prepareCompilationPass();
spaceScene.updateCameraRelative(cameraPositionKm);
renderer.setRenderTarget(renderTarget);
await renderer.compileAsync(spaceScene.scene, spaceScene.camera);
renderer.render(spaceScene.scene, spaceScene.camera);
renderer.setRenderTarget(null);
await renderer.compileAsync(spaceScene.scene, spaceScene.camera);
renderer.render(spaceScene.scene, spaceScene.camera);
shipEffects.endCompilationPass();

function measure(): { litPixels: number; meanLuminance: number } {
  let litPixels = 0;
  let luminanceSum = 0;
  for (let index = 0; index < pixels.length; index += 4) {
    const luminance =
      0.2126 * (pixels[index] ?? 0) +
      0.7152 * (pixels[index + 1] ?? 0) +
      0.0722 * (pixels[index + 2] ?? 0);
    if (luminance > 0) litPixels += 1;
    luminanceSum += luminance;
  }
  return { litPixels, meanLuminance: luminanceSum / (pixels.length / 4) };
}

globalThis.__shipVfxHarness = {
  async awaitModel(): Promise<void> {
    cameraPositionKm.x = AU_KM - distanceForDiameterPx(90);
    shipVisual.update(cameraPositionKm, VIEWPORT_SIZE, VERTICAL_FOV_RAD, 0);
    while (shipVisual.loadState === 'idle' || shipVisual.loadState === 'loading') {
      await new Promise((resolve) => globalThis.setTimeout(resolve, 50));
    }
  },
  step({ distanceKm, throttle, bodyRateRadS, simTimeSec, simDeltaSec, nowMs }) {
    advanceAttitude(bodyRateRadS, simDeltaSec);
    cameraPositionKm.x = AU_KM - distanceKm;
    cameraPositionKm.y = 0;
    cameraPositionKm.z = 0;
    spaceScene.camera.rotation.set(0, -Math.PI / 2, 0);
    spaceScene.camera.updateMatrix();
    spaceScene.camera.updateMatrixWorld(true);

    shipVisual.writeState(shipStateKm, attitudeQuaternion);
    // The real path: `ShipEffects` differentiates consecutive attitudes, so the
    // gate proves the production rule rather than a test-only shortcut.
    shipEffects.writeState(
      attitudeQuaternion,
      throttle,
      throttle * FULL_POWER_W,
      simTimeSec,
      simDeltaSec,
    );
    shipEffects.update(cameraPositionKm);
    shipVisual.update(cameraPositionKm, VIEWPORT_SIZE, VERTICAL_FOV_RAD, nowMs);
    lighting.update();
    spaceScene.updateCameraRelative(cameraPositionKm);

    renderer.info.reset();
    renderer.setRenderTarget(renderTarget);
    renderer.clear();
    renderer.render(spaceScene.scene, spaceScene.camera);
    renderer.readRenderTargetPixels(renderTarget, 0, 0, VIEWPORT_SIZE, VIEWPORT_SIZE, pixels);
    renderer.setRenderTarget(null);
    const { litPixels, meanLuminance } = measure();
    const snapshot: ShipVfxSnapshot = {
      throttle: shipEffects.throttle,
      burning: shipEffects.burning,
      beamLengthM: shipEffects.beamLengthM,
      beamIntensity: shipEffects.beamIntensity,
      beamSegments: shipEffects.beamSegments,
      rcsFiring: shipEffects.rcsFiring,
      rcsLivePuffCount: shipEffects.rcsLivePuffCount,
      rcsLiveCapacity: shipEffects.rcsLiveCapacity,
      lightCount: shipEffects.lightCount,
      beaconFactor: shipEffects.beaconFactor,
      navFactor: shipEffects.navFactor,
      modelBound: shipEffects.modelBound,
      anchorErrorM: shipEffects.anchorErrorM,
      anchorsVerified: shipEffects.anchorsVerified,
      nonFiniteObserved: shipEffects.nonFiniteObserved,
      degradedBindingCount: shipEffects.degradedBindingCount,
      skippedBindCount: shipEffects.skippedBindCount,
      plumeMagnitude: shipEffects.plumeMagnitude,
      pointMagnitude: shipVisual.pointMagnitude,
      cosExhaustAngle: shipEffects.cosExhaustAngle,
      litPixels,
      meanLuminance,
      drawCalls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
      programCount: renderer.info.programs?.length ?? -1,
      glError: renderer.getContext().getError(),
    };
    // Repeat onto the visible canvas so the fixture can be screenshotted; the
    // counters above are already captured.
    renderer.render(spaceScene.scene, spaceScene.camera);
    return snapshot;
  },
  applyRung(rung) {
    const profile = QUALITY_PROFILES[rung];
    if (profile === undefined) throw new Error(`No quality profile at rung ${String(rung)}.`);
    shipEffects.applyQuality(profile);
  },
  farField(distanceKm, throttle) {
    // The ship is unresolved at 1 AU, so this is exactly what the point sprite
    // is asked to render: reflected sunlight, then reflected plus plume.
    const farCameraKm = { x: AU_KM - distanceKm, y: 0, z: 0 };
    shipEffects.writeState(attitudeQuaternion, 0, 0, 0, 0);
    shipEffects.update(farCameraKm);
    shipVisual.update(farCameraKm, VIEWPORT_SIZE, VERTICAL_FOV_RAD, 0);
    const reflectedOnly = shipVisual.pointMagnitude;
    shipEffects.writeState(attitudeQuaternion, throttle, throttle * FULL_POWER_W, 0, 0);
    shipEffects.update(farCameraKm);
    shipVisual.update(farCameraKm, VIEWPORT_SIZE, VERTICAL_FOV_RAD, 0);
    return { withPlume: shipVisual.pointMagnitude, reflectedOnly };
  },
  loadState() {
    return shipVisual.loadState;
  },
  programCount() {
    return renderer.info.programs?.length ?? -1;
  },
};
