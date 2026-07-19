import type { WebGLRenderer } from 'three';

import bodiesDocument from '../../data/bodies.json';
import type { ReadonlyVec3 } from '../core/vec3.js';
import { createEpochState } from '../game/createEpochState.js';
import { OrbitCameraController, type CameraFocusTarget } from '../game/orbitCameraController.js';
import { loadAssetManifest } from './assetManifest.js';
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
import { loadStarCatalog, type StarCatalog } from './starCatalog.js';
import { Starfield } from './starfield.js';
import { TrajectoryOverlay } from './trajectoryOverlay.js';
import type { SystemMapBodyDefinition, SystemMapScene } from './systemMapScene.js';

import starCatalogUrl from '../../data/stars.bin?url';

export interface EpochWorld {
  readonly spaceScene: CameraRelativeSpaceScene;
  readonly visualSystem: BodyVisualSystem;
  readonly starfield: Starfield;
  readonly lighting: SolarLighting;
  readonly proceduralSun: ProceduralSun;
  readonly osculatingConic: OsculatingConicOverlay;
  readonly trajectoryOverlay: TrajectoryOverlay;
  readonly systemMap: SystemMapScene;
  readonly cameraController: OrbitCameraController;
  readonly cameraPositionKm: ReadonlyVec3;
  readonly positionsKm: Float64Array;
}

export interface CreateEpochWorldOptions {
  readonly assetLoader?: BodyVisualAssetLoader;
  readonly initialViewportWidthPx?: number;
  readonly initialViewportHeightPx?: number;
  readonly starCatalog?: StarCatalog;
}

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

  const cameraController = new OrbitCameraController({
    positionsKm: epochState.positionsKm,
    targets: cameraTargets,
    initialFocusId: 'earth',
    initialCameraPositionKm: epochState.cameraPositionKm,
  });

  const spaceScene = new CameraRelativeSpaceScene();
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
  const systemMap = new SystemMapScene(epochState.positionsKm, systemMapDefinitions, {
    viewportWidthPx: initialViewportWidthPx,
    viewportHeightPx: initialViewportHeightPx,
    pixelRatio: renderer.getPixelRatio(),
  });
  spaceScene.camera.lookAt(
    cameraController.lookDirection.x,
    cameraController.lookDirection.y,
    cameraController.lookDirection.z,
  );
  spaceScene.camera.updateMatrix();

  const lighting = new SolarLighting(
    spaceScene,
    epochState.positionsKm,
    sunIndex * 3,
    earthIndex * 3,
    solarRadiusKm,
  );
  const proceduralSun = new ProceduralSun(
    spaceScene,
    epochState.positionsKm,
    sunIndex * 3,
    solarRadiusKm,
    sunProceduralSeed,
  );

  const starCatalog = options.starCatalog ?? (await loadStarCatalog(starCatalogUrl));
  const starfield = new Starfield(starCatalog, renderer.getPixelRatio());
  spaceScene.scene.add(starfield.points);

  const assetLoader =
    options.assetLoader ??
    new BodyAssetLoader(
      renderer,
      await loadAssetManifest(`${import.meta.env.BASE_URL}assets/manifest.json`),
    );
  const compileModel: BodyModelCompiler = async (root) => {
    await renderer.compileAsync(root, spaceScene.camera, spaceScene.scene);
  };
  const visualSystem = new BodyVisualSystem(
    spaceScene,
    definitions,
    epochState.positionsKm,
    assetLoader,
    compileModel,
    proceduralSun,
  );

  await visualSystem.initializeEager();
  spaceScene.updateCameraRelative(cameraController.cameraPositionKm);
  osculatingConic.line.visible = true;
  trajectoryOverlay.prepareCompilationPass();
  await renderer.compileAsync(spaceScene.scene, spaceScene.camera);
  renderer.render(spaceScene.scene, spaceScene.camera);
  osculatingConic.line.visible = false;
  trajectoryOverlay.hide();
  visualSystem.initializeView(
    cameraController.cameraPositionKm,
    initialViewportHeightPx,
    spaceScene.camera.fov * (Math.PI / 180),
  );
  systemMap.trajectoryOverlay.prepareCompilationPass();
  await renderer.compileAsync(systemMap.spaceScene.scene, systemMap.spaceScene.camera);
  renderer.render(systemMap.spaceScene.scene, systemMap.spaceScene.camera);
  systemMap.trajectoryOverlay.hide();

  return {
    spaceScene,
    visualSystem,
    starfield,
    lighting,
    proceduralSun,
    osculatingConic,
    trajectoryOverlay,
    systemMap,
    cameraController,
    cameraPositionKm: cameraController.cameraPositionKm,
    positionsKm: epochState.positionsKm,
  };
}
