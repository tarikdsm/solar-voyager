import { AmbientLight, DirectionalLight, type WebGLRenderer } from 'three';

import type { ReadonlyVec3 } from '../core/vec3.js';
import { createEpochState } from '../game/createEpochState.js';
import { loadAssetManifest } from './assetManifest.js';
import { BodyAssetLoader } from './bodyAssetLoader.js';
import {
  BodyVisualSystem,
  type BodyModelCompiler,
  type BodyVisualAssetLoader,
  type BodyVisualDefinition,
} from './bodyVisualSystem.js';
import { CameraRelativeSpaceScene } from './spaceScene.js';

export interface EpochWorld {
  readonly spaceScene: CameraRelativeSpaceScene;
  readonly visualSystem: BodyVisualSystem;
  readonly cameraPositionKm: ReadonlyVec3;
  readonly positionsKm: Float64Array;
}

export interface CreateEpochWorldOptions {
  readonly assetLoader?: BodyVisualAssetLoader;
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
  for (const body of epochState.bodies) {
    definitions.push({
      id: body.id,
      category: runtimeCategory(body.kind),
      meanRadiusKm: body.meanRadiusKm,
      geometricAlbedo: body.geometricAlbedo,
      albedoColor: parseAlbedoColor(body.albedoColor),
    });
  }

  const spaceScene = new CameraRelativeSpaceScene();
  spaceScene.camera.lookAt(
    epochState.cameraLookDirection.x,
    epochState.cameraLookDirection.y,
    epochState.cameraLookDirection.z,
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
  spaceScene.updateCameraRelative(epochState.cameraPositionKm);
  await renderer.compileAsync(spaceScene.scene, spaceScene.camera);

  return {
    spaceScene,
    visualSystem,
    cameraPositionKm: epochState.cameraPositionKm,
    positionsKm: epochState.positionsKm,
  };
}
