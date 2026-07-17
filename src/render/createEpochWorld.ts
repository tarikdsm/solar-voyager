import { AmbientLight, DirectionalLight, type WebGLRenderer } from 'three';

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
import { loadStarCatalog, type StarCatalog } from './starCatalog.js';
import { Starfield } from './starfield.js';

import starCatalogUrl from '../../data/stars.bin?url';

export interface EpochWorld {
  readonly spaceScene: CameraRelativeSpaceScene;
  readonly visualSystem: BodyVisualSystem;
  readonly starfield: Starfield;
  readonly cameraController: OrbitCameraController;
  readonly cameraPositionKm: ReadonlyVec3;
  readonly positionsKm: Float64Array;
}

export interface CreateEpochWorldOptions {
  readonly assetLoader?: BodyVisualAssetLoader;
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
  const cameraTargets: CameraFocusTarget[] = [];
  for (let index = 0; index < epochState.bodies.length; index += 1) {
    const body = epochState.bodies[index];
    if (body === undefined) throw new Error('Epoch body array is sparse.');
    definitions.push({
      id: body.id,
      category: runtimeCategory(body.kind),
      meanRadiusKm: body.meanRadiusKm,
      geometricAlbedo: body.geometricAlbedo,
      albedoColor: parseAlbedoColor(body.albedoColor),
    });
    cameraTargets.push({
      id: body.id,
      positionOffset: index * 3,
      meanRadiusKm: body.meanRadiusKm,
    });
  }

  const cameraController = new OrbitCameraController({
    positionsKm: epochState.positionsKm,
    targets: cameraTargets,
    initialFocusId: 'earth',
    initialCameraPositionKm: epochState.cameraPositionKm,
  });

  const spaceScene = new CameraRelativeSpaceScene();
  spaceScene.camera.lookAt(
    cameraController.lookDirection.x,
    cameraController.lookDirection.y,
    cameraController.lookDirection.z,
  );
  spaceScene.camera.updateMatrix();

  const ambientLight = new AmbientLight(0xffffff, 0.02);
  ambientLight.matrixAutoUpdate = false;
  ambientLight.updateMatrix();
  const directionalLight = new DirectionalLight(0xffffff, 2);
  directionalLight.position.set(
    -epochState.cameraLookDirection.x,
    -epochState.cameraLookDirection.y,
    -epochState.cameraLookDirection.z,
  );
  directionalLight.matrixAutoUpdate = false;
  directionalLight.updateMatrix();
  spaceScene.scene.add(ambientLight, directionalLight);

  const starCatalog = options.starCatalog ?? (await loadStarCatalog(starCatalogUrl));
  const starfield = new Starfield(starCatalog, renderer.getPixelRatio());
  spaceScene.scene.add(starfield.points);

  const assetLoader =
    options.assetLoader ??
    new BodyAssetLoader(
      renderer,
      await loadAssetManifest(`${import.meta.env.BASE_URL}assets/manifest.json`),
    );
  const compileModel: BodyModelCompiler = async () => {
    await renderer.compileAsync(spaceScene.scene, spaceScene.camera);
  };
  const visualSystem = new BodyVisualSystem(
    spaceScene,
    definitions,
    epochState.positionsKm,
    assetLoader,
    compileModel,
  );

  await visualSystem.initializeEager();
  spaceScene.updateCameraRelative(cameraController.cameraPositionKm);
  await renderer.compileAsync(spaceScene.scene, spaceScene.camera);
  visualSystem.initializeView(
    cameraController.cameraPositionKm,
    options.initialViewportHeightPx ?? Math.max(1, renderer.domElement.height),
    spaceScene.camera.fov * (Math.PI / 180),
  );

  return {
    spaceScene,
    visualSystem,
    starfield,
    cameraController,
    cameraPositionKm: cameraController.cameraPositionKm,
    positionsKm: epochState.positionsKm,
  };
}
