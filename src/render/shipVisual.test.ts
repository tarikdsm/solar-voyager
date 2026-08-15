import { Group, Mesh, MeshStandardMaterial, Object3D, Vector3 } from 'three';
import { describe, expect, it, vi } from 'vitest';

import {
  writeForwardFromQuaternionInto,
  writeQuaternionFromForwardInto,
} from '../sim/ship/attitude.js';
import type { LoadedBodyModel } from './bodyAssetLoader.js';
import { BodyPointCloud } from './bodyPointCloud.js';
import {
  ShipVisual,
  SHIP_BOUNDING_RADIUS_KM,
  SHIP_MODEL_SCALE_KM_PER_UNIT,
  SHIP_NOSE_NODE_NAME,
  type ShipVisualAssetLoader,
} from './shipVisual.js';
import { CameraRelativeSpaceScene } from './spaceScene.js';

const AU_KM = 149_597_870.7;
const SUN_INDEX = 0;
const SHIP_INDEX = 1;
const VIEWPORT_HEIGHT_PX = 720;
const VERTICAL_FOV_RAD = (75 * Math.PI) / 180;
const IDENTITY_QUATERNION = new Float64Array([0, 0, 0, 1]);

/** Sun at the origin, ship one astronomical unit along `+X`. */
function positions(): Float64Array {
  return new Float64Array([0, 0, 0, AU_KM, 0, 0]);
}

function shipState(x: number, y: number, z: number): Float64Array {
  return new Float64Array([x, y, z, 0, 0, 0, 0]);
}

/**
 * A stand-in for the real asset: a nose child at model-space `+12` metres, which
 * is where `build_ship.py` puts `hull_tip`.
 */
function loadedModel(): {
  model: LoadedBodyModel;
  nose: Object3D;
  material: MeshStandardMaterial;
} {
  const root = new Group();
  const material = new MeshStandardMaterial();
  root.add(new Mesh(undefined, material));
  const nose = new Object3D();
  nose.name = SHIP_NOSE_NODE_NAME;
  nose.position.set(12, 0, 0);
  nose.updateMatrix();
  root.add(nose);
  return { model: { root, materials: [material], surfaceDetail: null }, nose, material };
}

interface Harness {
  readonly shipVisual: ShipVisual;
  readonly spaceScene: CameraRelativeSpaceScene;
  readonly pointCloud: BodyPointCloud;
  readonly positionsKm: Float64Array;
  readonly loadModel: ReturnType<typeof vi.fn>;
  readonly compileModel: ReturnType<typeof vi.fn>;
}

function harness(model: LoadedBodyModel | null, lazyLoadingEnabled = true): Harness {
  const spaceScene = new CameraRelativeSpaceScene();
  const pointCloud = new BodyPointCloud(new Uint32Array([0xff_ff_ff, 0xdf_e6_ef]));
  const positionsKm = positions();
  const loadModel = vi.fn(async () => model);
  const compileModel = vi.fn(async () => undefined);
  const assetLoader: ShipVisualAssetLoader = { loadModel };
  const shipVisual = new ShipVisual({
    spaceScene,
    pointCloud,
    positionsKm,
    shipIndex: SHIP_INDEX,
    sunIndex: SUN_INDEX,
    assetLoader,
    compileModel,
    lazyLoadingEnabled,
  });
  return { shipVisual, spaceScene, pointCloud, positionsKm, loadModel, compileModel };
}

/** Distance at which the hull projects to the requested vertical pixel count. */
function distanceForDiameterPx(diameterPx: number): number {
  const angularDiameterRad = (diameterPx * VERTICAL_FOV_RAD) / VIEWPORT_HEIGHT_PX;
  return SHIP_BOUNDING_RADIUS_KM / Math.sin(angularDiameterRad / 2);
}

/** Observes from a right angle to the sun, so the hull is half lit at any range. */
function stepAtDistance(rig: Harness, distanceKm: number, nowMs: number): void {
  rig.shipVisual.update(
    { x: AU_KM, y: distanceKm, z: 0 },
    VIEWPORT_HEIGHT_PX,
    VERTICAL_FOV_RAD,
    nowMs,
  );
}

describe('ShipVisual attitude', () => {
  it('carries the model nose onto the physics forward direction', () => {
    const rig = harness(null);
    const forwards = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
      [-1, 0, 0],
      [0.3, -0.7, 0.64807407],
      [-0.9, 0.2, 0.38729833],
    ];
    const quaternion = new Float64Array(4);
    const expected = new Float64Array(3);
    for (const [x, y, z] of forwards) {
      writeQuaternionFromForwardInto(quaternion, x as number, y as number, z as number);
      rig.shipVisual.writeState(shipState(AU_KM, 0, 0), quaternion);
      writeForwardFromQuaternionInto(expected, quaternion);
      expect(rig.shipVisual.noseAlignment).toBeCloseTo(1, 14);
      // The physics forward itself must be the requested direction, so the
      // alignment above is not comparing two identically wrong vectors.
      const magnitude = Math.hypot(x as number, y as number, z as number);
      expect(expected[0]).toBeCloseTo((x as number) / magnitude, 12);
      expect(expected[1]).toBeCloseTo((y as number) / magnitude, 12);
      expect(expected[2]).toBeCloseTo((z as number) / magnitude, 12);
    }
  });

  it('rolls the model up axis onto the body up axis', async () => {
    // ADR-025 §4: body +Y is the pitch (lateral) axis and body +Z is the yaw
    // (up) axis, while the exported model is Y-up. Identity attitude must
    // therefore stand the model up along world +Z, and put the model's lateral
    // axis on the world Y axis.
    const { model } = loadedModel();
    const rig = harness(model);
    rig.shipVisual.writeState(shipState(AU_KM, 0, 0), IDENTITY_QUATERNION);
    stepAtDistance(rig, distanceForDiameterPx(40), 0);
    await vi.waitFor(() => expect(rig.shipVisual.loadState).toBe('ready'));
    rig.shipVisual.writeState(shipState(AU_KM, 0, 0), IDENTITY_QUATERNION);

    const nose = new Vector3(1, 0, 0).applyQuaternion(model.root.quaternion);
    const up = new Vector3(0, 1, 0).applyQuaternion(model.root.quaternion);
    const lateral = new Vector3(0, 0, 1).applyQuaternion(model.root.quaternion);
    expect(nose.distanceTo(new Vector3(1, 0, 0))).toBeLessThan(1e-7);
    expect(up.distanceTo(new Vector3(0, 0, 1))).toBeLessThan(1e-7);
    expect(lateral.distanceTo(new Vector3(0, -1, 0))).toBeLessThan(1e-7);
  });

  it('measures the loaded asset nose node against the physics forward', async () => {
    const { model } = loadedModel();
    const rig = harness(model);
    const quaternion = new Float64Array(4);
    writeQuaternionFromForwardInto(quaternion, 0, 0, 1);
    rig.shipVisual.writeState(shipState(AU_KM, 0, 0), quaternion);
    expect(rig.shipVisual.noseNodeAlignment).toBe(-2);

    stepAtDistance(rig, distanceForDiameterPx(4), 0);
    await vi.waitFor(() => expect(rig.shipVisual.loadState).toBe('ready'));
    rig.shipVisual.writeState(shipState(AU_KM, 0, 0), quaternion);
    expect(rig.shipVisual.noseNodeAlignment).toBeCloseTo(1, 6);

    writeQuaternionFromForwardInto(quaternion, -1, 0, 0);
    rig.shipVisual.writeState(shipState(AU_KM, 0, 0), quaternion);
    expect(rig.shipVisual.noseNodeAlignment).toBeCloseTo(1, 6);
  });

  it('rejects non-finite ship state instead of drawing it', () => {
    const rig = harness(null);
    expect(() =>
      rig.shipVisual.writeState(shipState(Number.NaN, 0, 0), IDENTITY_QUATERNION),
    ).toThrow(RangeError);
    expect(() =>
      rig.shipVisual.writeState(
        shipState(AU_KM, 0, 0),
        new Float64Array([0, 0, 0, Number.POSITIVE_INFINITY]),
      ),
    ).toThrow(RangeError);
  });
});

describe('ShipVisual representation', () => {
  it('publishes the ship position into the shared packed array', () => {
    const rig = harness(null);
    rig.shipVisual.writeState(shipState(1, 2, 3), IDENTITY_QUATERNION);
    expect(Array.from(rig.positionsKm.subarray(3))).toEqual([1, 2, 3]);
  });

  it('stays a point below the resolve threshold and never fetches the model', () => {
    const rig = harness(null);
    rig.shipVisual.writeState(shipState(AU_KM, 0, 0), IDENTITY_QUATERNION);
    stepAtDistance(rig, distanceForDiameterPx(1), 0);
    expect(rig.shipVisual.resolved).toBe(false);
    expect(rig.shipVisual.diameterPx).toBeCloseTo(1, 6);
    expect(rig.shipVisual.pointOpacity).toBe(1);
    expect(rig.shipVisual.modelOpacity).toBe(0);
    expect(rig.loadModel).not.toHaveBeenCalled();
  });

  it('holds the point representation across the hysteresis band', () => {
    const rig = harness(null);
    rig.shipVisual.writeState(shipState(AU_KM, 0, 0), IDENTITY_QUATERNION);
    stepAtDistance(rig, distanceForDiameterPx(1.5), 0);
    expect(rig.shipVisual.resolved).toBe(false);
    stepAtDistance(rig, distanceForDiameterPx(2), 16);
    expect(rig.shipVisual.resolved).toBe(true);
    stepAtDistance(rig, distanceForDiameterPx(1.5), 32);
    expect(rig.shipVisual.resolved).toBe(true);
    stepAtDistance(rig, distanceForDiameterPx(1), 48);
    expect(rig.shipVisual.resolved).toBe(false);
  });

  it('defers the model fetch until lazy loading is enabled', () => {
    const rig = harness(null, false);
    rig.shipVisual.writeState(shipState(AU_KM, 0, 0), IDENTITY_QUATERNION);
    stepAtDistance(rig, distanceForDiameterPx(40), 0);
    expect(rig.shipVisual.resolved).toBe(true);
    expect(rig.loadModel).not.toHaveBeenCalled();
    rig.shipVisual.enableLazyLoading();
    stepAtDistance(rig, distanceForDiameterPx(40), 16);
    expect(rig.loadModel).toHaveBeenCalledTimes(1);
  });

  it('binds, scales, precompiles and cross-fades the loaded model', async () => {
    const { model, material } = loadedModel();
    const rig = harness(model);
    rig.shipVisual.writeState(shipState(AU_KM, 0, 0), IDENTITY_QUATERNION);
    stepAtDistance(rig, distanceForDiameterPx(40), 0);
    await vi.waitFor(() => expect(rig.shipVisual.loadState).toBe('ready'));

    expect(rig.compileModel).toHaveBeenCalledTimes(1);
    expect(model.root.parent).toBe(rig.spaceScene.scene);
    expect(model.root.scale.x).toBe(SHIP_MODEL_SCALE_KM_PER_UNIT);
    expect(model.root.matrixAutoUpdate).toBe(false);
    expect(material.envMap).not.toBeNull();

    stepAtDistance(rig, distanceForDiameterPx(40), 100);
    expect(rig.shipVisual.modelOpacity).toBe(0);
    stepAtDistance(rig, distanceForDiameterPx(40), 225);
    expect(rig.shipVisual.modelOpacity).toBeGreaterThan(0);
    expect(rig.shipVisual.modelOpacity).toBeLessThan(1);
    expect(rig.shipVisual.pointOpacity).toBeLessThan(1);
    expect(model.root.visible).toBe(true);

    stepAtDistance(rig, distanceForDiameterPx(40), 400);
    expect(rig.shipVisual.modelOpacity).toBe(1);
    expect(rig.shipVisual.pointOpacity).toBe(0);
    expect(material.opacity).toBe(1);
    expect(material.transparent).toBe(false);
    expect(material.depthWrite).toBe(true);

    stepAtDistance(rig, distanceForDiameterPx(1), 500);
    stepAtDistance(rig, distanceForDiameterPx(1), 800);
    expect(rig.shipVisual.resolved).toBe(false);
    expect(rig.shipVisual.modelOpacity).toBe(0);
    expect(rig.shipVisual.pointOpacity).toBe(1);
    expect(model.root.visible).toBe(false);
  });

  it('keeps the point representation when the asset is unavailable', async () => {
    const rig = harness(null);
    rig.shipVisual.writeState(shipState(AU_KM, 0, 0), IDENTITY_QUATERNION);
    stepAtDistance(rig, distanceForDiameterPx(40), 0);
    await vi.waitFor(() => expect(rig.shipVisual.loadState).toBe('failed'));
    stepAtDistance(rig, distanceForDiameterPx(40), 400);
    expect(rig.shipVisual.pointOpacity).toBe(1);
    expect(rig.shipVisual.modelOpacity).toBe(0);
  });

  it('brightens the shared point with the physical apparent magnitude', () => {
    const rig = harness(null);
    rig.shipVisual.writeState(shipState(AU_KM, 0, 0), IDENTITY_QUATERNION);
    const intensities = rig.pointCloud.points.geometry.getAttribute('aIntensity');

    stepAtDistance(rig, 1_000, 0);
    const nearIntensity = intensities.getX(SHIP_INDEX);
    stepAtDistance(rig, AU_KM, 16);
    const farIntensity = intensities.getX(SHIP_INDEX);

    expect(nearIntensity).toBeGreaterThan(farIntensity);
    expect(nearIntensity).toBe(8);
    // A 26 m hull is genuinely invisible one astronomical unit away; the plume
    // (T0122) is what makes a burning ship readable at that range.
    expect(farIntensity).toBeLessThan(1e-3);
  });
});
