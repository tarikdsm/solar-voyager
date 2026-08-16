import type { WebGLRenderer } from 'three';

import bodiesDocument from '../../data/bodies.json';
import type { ReadonlyVec3 } from '../core/vec3.js';
import { CameraDirector, type CameraMode } from '../game/cameraDirector.js';
import { ChaseCameraController } from '../game/chaseCameraController.js';
import { createEpochState } from '../game/createEpochState.js';
import { OrbitCameraController, type CameraFocusTarget } from '../game/orbitCameraController.js';
import { loadAssetManifest } from './assetManifest.js';
import { applyCameraPose } from './cameraRig.js';
import { BodyAssetLoader } from './bodyAssetLoader.js';
import {
  BodyVisualSystem,
  type BodyModelCompiler,
  type BodyVisualAssetLoader,
  type BodyVisualDefinition,
} from './bodyVisualSystem.js';
import { CameraRelativeSpaceScene } from './spaceScene.js';
import { SolarLighting } from './solarLighting.js';
import { OsculatingConicOverlay } from './osculatingConicOverlay.js';
import { ProceduralSun } from './proceduralSun.js';
import { ShipEffects } from './shipEffects.js';
import {
  ShipVisual,
  SHIP_ASSET_ID,
  SHIP_BOUNDING_RADIUS_KM,
  SHIP_LENGTH_M,
  SHIP_MODEL_SCALE_KM_PER_UNIT,
  SHIP_POINT_COLOR,
} from './shipVisual.js';
import { loadStarCatalog, type StarCatalog } from './starCatalog.js';
import { Starfield } from './starfield.js';
import { TrajectoryOverlay } from './trajectoryOverlay.js';
import type { SystemMapBodyDefinition, SystemMapScene } from './systemMapScene.js';

import starCatalogUrl from '../../data/stars.bin?url';

export interface EpochWorld {
  readonly spaceScene: CameraRelativeSpaceScene;
  readonly visualSystem: BodyVisualSystem;
  readonly shipVisual: ShipVisual;
  /** Photon beam, nozzle glow, RCS puffs and the running lights (T0122). */
  readonly shipEffects: ShipEffects;
  readonly starfield: Starfield;
  readonly lighting: SolarLighting;
  readonly proceduralSun: ProceduralSun;
  readonly osculatingConic: OsculatingConicOverlay;
  readonly trajectoryOverlay: TrajectoryOverlay;
  readonly systemMap: SystemMapScene;
  /**
   * The v1 orbit camera, now one of two the director drives.
   *
   * Still exposed because the system map owns a second, independent instance of
   * the same class and the two are wired the same way — but the *space* camera
   * must be driven through {@link cameraDirector}, never directly, or the mode
   * and the pose fall out of step.
   */
  readonly cameraController: OrbitCameraController;
  /** Owns the space camera: mode, cross-fades and focus routing (T0110). */
  readonly cameraDirector: CameraDirector;
  readonly cameraPositionKm: ReadonlyVec3;
  /**
   * Packed float64 positions: one triple per catalog body, then the ship.
   *
   * `set(snapshot.bodyPositionsKm)` writes the body prefix and leaves the ship
   * triple to `ShipVisual.writeState`.
   */
  readonly positionsKm: Float64Array;
  /** Component offset of the ship's triple in `positionsKm`, and its camera-target offset. */
  readonly shipPositionOffset: number;
  /** Body index of the Sun in `positionsKm` — the zero point of every magnitude. */
  readonly sunIndex: number;
  /** Body-major mean radii, shared with the chase arm (T0110) and exposure (T0127). */
  readonly bodyRadiiKm: Float64Array;
  /** Body-major geometric albedos, for the reflected term of the exposure key (T0127). */
  readonly bodyGeometricAlbedos: Float64Array;
}

export interface CreateEpochWorldOptions {
  readonly assetLoader?: BodyVisualAssetLoader;
  readonly initialViewportWidthPx?: number;
  readonly initialViewportHeightPx?: number;
  readonly onProgress?: ((milestone: EpochWorldMilestone) => void) | null;
  readonly starCatalog?: StarCatalog;
  /**
   * Ship attitude used to place the warm-up camera, xyzw; defaults to identity.
   *
   * Setup renders and rebases against a real camera position before any
   * simulation step has run, so the chase arm needs an attitude to hang from.
   * Passing the session's actual epoch attitude puts the warm-up camera where
   * the first ordinary frame will be.
   */
  readonly initialShipAttitudeQuaternion?: Float64Array;
  /** Starting camera mode; `chase` unless a fixture wants v1's framing. */
  readonly initialCameraMode?: CameraMode;
}

export type EpochWorldMilestone =
  'star-catalog' | 'asset-manifest' | 'hero-spheres' | 'flight-shaders' | 'map-shaders';

function runtimeCategory(kind: string): BodyVisualDefinition['category'] {
  switch (kind) {
    case 'star':
      return 'sun';
    case 'planet':
    case 'moon':
    case 'dwarf':
    case 'asteroid':
    case 'comet':
      return kind;
    default:
      throw new Error(`Unsupported body visual kind "${kind}".`);
  }
}

function parseAlbedoColor(color: string): number {
  if (!/^#[0-9a-f]{6}$/iu.test(color)) {
    throw new Error(`Invalid catalog albedo color "${color}".`);
  }
  return Number.parseInt(color.slice(1), 16);
}

/** Creates render resources from the game-owned fixed J2026 state. */
export async function createEpochWorld(
  renderer: WebGLRenderer,
  options: CreateEpochWorldOptions = {},
): Promise<EpochWorld> {
  const epochState = createEpochState();
  const bodyCount = epochState.bodies.length;
  // One shared packed array: catalog bodies first, then the ship. Every
  // camera-relative binding, the camera focus targets, the solar lighting focus
  // and the apparent-magnitude path all address it by offset, so the ship needs
  // no parallel machinery. The system map keeps a body-only view of the same
  // buffer because its contract is one icon per catalog body.
  const positionsKm = new Float64Array((bodyCount + 1) * 3);
  positionsKm.set(epochState.positionsKm);
  const shipIndex = bodyCount;
  const shipPositionOffset = shipIndex * 3;
  positionsKm[shipPositionOffset] = epochState.shipPositionKm.x;
  positionsKm[shipPositionOffset + 1] = epochState.shipPositionKm.y;
  positionsKm[shipPositionOffset + 2] = epochState.shipPositionKm.z;
  const bodyPositionsKm = positionsKm.subarray(0, bodyCount * 3);
  // Body-major radii, so the chase arm can keep itself outside whichever body it
  // is near without carrying a copy of the catalog.
  const bodyRadiiKm = new Float64Array(bodyCount);
  const bodyGeometricAlbedos = new Float64Array(bodyCount);
  const definitions: BodyVisualDefinition[] = [];
  const systemMapDefinitions: SystemMapBodyDefinition[] = [];
  const cameraTargets: CameraFocusTarget[] = [];
  let sunIndex = -1;
  let earthIndex = -1;
  let solarRadiusKm = 0;
  let sunProceduralSeed = -1;
  for (let index = 0; index < epochState.bodies.length; index += 1) {
    const body = epochState.bodies[index];
    if (body === undefined) throw new Error('Epoch body array is sparse.');
    definitions.push({
      id: body.id,
      category: runtimeCategory(body.kind),
      axialTiltRad: body.axialTiltRad,
      siderealRotationPeriodSec: body.siderealRotationPeriodSec,
      meanRadiusKm: body.meanRadiusKm,
      muKm3S2: body.muKm3S2,
      polarRadiusRatio: body.polarRadiusRatio,
      geometricAlbedo: body.geometricAlbedo,
      albedoColor: parseAlbedoColor(body.albedoColor),
      proceduralSeed: body.proceduralSeed,
    });
    const catalogBody = bodiesDocument.bodies[index];
    if (catalogBody === undefined || catalogBody.id !== body.id) {
      throw new Error('Epoch state and catalog body order must match.');
    }
    let parentIndex = -1;
    if (catalogBody.parentId !== null) {
      for (let candidateIndex = 0; candidateIndex < index; candidateIndex += 1) {
        if (bodiesDocument.bodies[candidateIndex]?.id === catalogBody.parentId) {
          parentIndex = candidateIndex;
          break;
        }
      }
      if (parentIndex < 0) {
        throw new Error(`System-map parent "${catalogBody.parentId}" must precede ${body.id}.`);
      }
    }
    systemMapDefinitions.push({
      id: body.id,
      parentIndex,
      meanRadiusKm: body.meanRadiusKm,
      muKm3S2: body.muKm3S2,
      albedoColor: parseAlbedoColor(body.albedoColor),
      elements: catalogBody.elements,
    });
    if (body.id === 'sun') {
      sunIndex = index;
      solarRadiusKm = body.meanRadiusKm;
      sunProceduralSeed = body.proceduralSeed;
    }
    if (body.id === 'earth') earthIndex = index;
    bodyRadiiKm[index] = body.meanRadiusKm;
    bodyGeometricAlbedos[index] = body.geometricAlbedo;
    cameraTargets.push({
      id: body.id,
      positionOffset: index * 3,
      meanRadiusKm: body.meanRadiusKm,
    });
  }
  if (
    sunIndex < 0 ||
    earthIndex < 0 ||
    solarRadiusKm <= 0 ||
    !Number.isInteger(sunProceduralSeed) ||
    sunProceduralSeed < 0
  ) {
    throw new Error('Epoch lighting requires catalogued Sun and Earth definitions.');
  }

  cameraTargets.push({
    id: SHIP_ASSET_ID,
    positionOffset: shipPositionOffset,
    meanRadiusKm: SHIP_BOUNDING_RADIUS_KM,
  });

  const cameraController = new OrbitCameraController({
    positionsKm,
    targets: cameraTargets,
    initialFocusId: 'earth',
    initialCameraPositionKm: epochState.cameraPositionKm,
  });

  const chaseCameraController = new ChaseCameraController({
    positionsKm,
    shipPositionOffset,
    shipLengthKm: SHIP_LENGTH_M * SHIP_MODEL_SCALE_KM_PER_UNIT,
    bodyRadiiKm,
  });

  const spaceScene = new CameraRelativeSpaceScene();
  const cameraDirector = new CameraDirector({
    orbit: cameraController,
    chase: chaseCameraController,
    shipFocusId: SHIP_ASSET_ID,
    shipPositionOffset,
    baseFovDeg: spaceScene.camera.fov,
    ...(options.initialCameraMode === undefined ? {} : { initialMode: options.initialCameraMode }),
    defaultObservatoryFocusId: 'earth',
  });
  cameraDirector.prime(options.initialShipAttitudeQuaternion ?? new Float64Array([0, 0, 0, 1]));
  const cameraPositionKm = cameraDirector.cameraPositionKm;
  const osculatingConic = new OsculatingConicOverlay(spaceScene);
  const trajectoryBodyIds: string[] = [];
  for (let index = 0; index < epochState.bodies.length; index += 1) {
    const body = epochState.bodies[index];
    if (body === undefined) throw new Error('Epoch body array is sparse.');
    trajectoryBodyIds.push(body.id);
  }
  const trajectoryOverlay = new TrajectoryOverlay(spaceScene, trajectoryBodyIds);
  const { SystemMapScene } = await import('./systemMapScene.js');
  const initialViewportHeightPx =
    options.initialViewportHeightPx ?? Math.max(1, renderer.domElement.height);
  const drawingBufferWidthPx = renderer.domElement.width;
  const drawingBufferHeightPx = renderer.domElement.height;
  const drawingBufferAspect =
    Number.isFinite(drawingBufferWidthPx) &&
    drawingBufferWidthPx > 0 &&
    Number.isFinite(drawingBufferHeightPx) &&
    drawingBufferHeightPx > 0
      ? drawingBufferWidthPx / drawingBufferHeightPx
      : 1;
  const initialViewportWidthPx =
    options.initialViewportWidthPx ?? initialViewportHeightPx * drawingBufferAspect;
  const systemMap = new SystemMapScene(bodyPositionsKm, systemMapDefinitions, {
    viewportWidthPx: initialViewportWidthPx,
    viewportHeightPx: initialViewportHeightPx,
    pixelRatio: renderer.getPixelRatio(),
  });
  applyCameraPose(spaceScene.camera, cameraDirector.pose);

  const lighting = new SolarLighting(
    spaceScene,
    positionsKm,
    sunIndex * 3,
    earthIndex * 3,
    solarRadiusKm,
  );
  const proceduralSun = new ProceduralSun(
    spaceScene,
    positionsKm,
    sunIndex * 3,
    solarRadiusKm,
    sunProceduralSeed,
  );

  const starCatalog = options.starCatalog ?? (await loadStarCatalog(starCatalogUrl));
  options.onProgress?.('star-catalog');
  const starfield = new Starfield(starCatalog, renderer.getPixelRatio());
  spaceScene.scene.add(starfield.points);

  const assetLoader =
    options.assetLoader ??
    new BodyAssetLoader(
      renderer,
      await loadAssetManifest(`${import.meta.env.BASE_URL}assets/manifest.json`),
    );
  options.onProgress?.('asset-manifest');
  const compileModel: BodyModelCompiler = async (root) => {
    await renderer.compileAsync(root, spaceScene.camera, spaceScene.scene);
  };
  const visualSystem = new BodyVisualSystem(
    spaceScene,
    definitions,
    positionsKm,
    assetLoader,
    compileModel,
    proceduralSun,
    false,
    [SHIP_POINT_COLOR],
  );
  const shipVisual = new ShipVisual({
    spaceScene,
    pointCloud: visualSystem.pointCloud,
    positionsKm,
    shipIndex,
    sunIndex,
    assetLoader,
    compileModel,
    lazyLoadingEnabled: false,
  });
  const shipEffects = new ShipEffects({
    spaceScene,
    shipVisual,
    positionsKm,
    shipIndex,
  });

  await visualSystem.initializeEager();
  options.onProgress?.('hero-spheres');
  // Before the first warm-up render: an unwritten point-cloud slot defaults to a
  // fully opaque unit-size dot, and the ship owns slot `shipIndex`.
  shipVisual.update(
    cameraPositionKm,
    initialViewportHeightPx,
    spaceScene.camera.fov * (Math.PI / 180),
    0,
  );
  spaceScene.updateCameraRelative(cameraPositionKm);
  osculatingConic.line.visible = true;
  trajectoryOverlay.prepareCompilationPass(cameraPositionKm, cameraDirector.pose.lookDirection);
  // T0122 — the beam, the glow and the puff pool must be lit and on screen for
  // this one render, or the first throttle input of the session pays for their
  // shader compile. Same contract as the trajectory overlay above.
  shipEffects.prepareCompilationPass();
  await renderer.compileAsync(spaceScene.scene, spaceScene.camera);
  renderer.render(spaceScene.scene, spaceScene.camera);
  options.onProgress?.('flight-shaders');
  osculatingConic.line.visible = false;
  trajectoryOverlay.hide();
  shipEffects.endCompilationPass();
  visualSystem.initializeView(
    cameraPositionKm,
    initialViewportHeightPx,
    spaceScene.camera.fov * (Math.PI / 180),
  );
  systemMap.trajectoryOverlay.prepareCompilationPass(
    systemMap.cameraPositionKm,
    systemMap.cameraController.lookDirection,
  );
  await renderer.compileAsync(systemMap.spaceScene.scene, systemMap.spaceScene.camera);
  renderer.render(systemMap.spaceScene.scene, systemMap.spaceScene.camera);
  options.onProgress?.('map-shaders');
  systemMap.trajectoryOverlay.hide();

  return {
    spaceScene,
    visualSystem,
    shipVisual,
    shipEffects,
    starfield,
    lighting,
    proceduralSun,
    osculatingConic,
    trajectoryOverlay,
    systemMap,
    cameraController,
    cameraDirector,
    cameraPositionKm,
    positionsKm,
    shipPositionOffset,
    sunIndex,
    bodyRadiiKm,
    bodyGeometricAlbedos,
  };
}
