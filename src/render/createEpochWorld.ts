import type { WebGLRenderer } from 'three';

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
import { SolarLighting } from './solarLighting.js';
import { loadStarCatalog, type StarCatalog } from './starCatalog.js';
import { Starfield } from './starfield.js';

import starCatalogUrl from '../../data/stars.bin?url';

export interface EpochWorld {
  readonly spaceScene: CameraRelativeSpaceScene;
  readonly visualSystem: BodyVisualSystem;
  readonly starfield: Starfield;
  readonly lighting: SolarLighting;
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
  let sunIndex = -1;
  let earthIndex = -1;
  let solarRadiusKm = 0;
  for (let bodyIndex = 0; bodyIndex < epochState.bodies.length; bodyIndex += 1) {
    const body = epochState.bodies[bodyIndex];
    if (body === undefined) throw new Error('Epoch body definition array is sparse.');
    definitions.push({
      id: body.id,
      category: runtimeCategory(body.kind),
      meanRadiusKm: body.meanRadiusKm,
      geometricAlbedo: body.geometricAlbedo,
      albedoColor: parseAlbedoColor(body.albedoColor),
    });
    if (body.id === 'sun') {
      sunIndex = bodyIndex;
      solarRadiusKm = body.meanRadiusKm;
    }
    if (body.id === 'earth') earthIndex = bodyIndex;
  }
  if (sunIndex < 0 || earthIndex < 0 || solarRadiusKm <= 0) {
    throw new Error('Epoch lighting requires catalogued Sun and Earth definitions.');
  }

  const spaceScene = new CameraRelativeSpaceScene();
  spaceScene.camera.lookAt(
    epochState.cameraLookDirection.x,
    epochState.cameraLookDirection.y,
    epochState.cameraLookDirection.z,
  );
  spaceScene.camera.updateMatrix();

  const lighting = new SolarLighting(
    spaceScene,
    epochState.positionsKm,
    sunIndex * 3,
    earthIndex * 3,
    solarRadiusKm,
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
  visualSystem.initializeView(
    epochState.cameraPositionKm,
    options.initialViewportHeightPx ?? Math.max(1, renderer.domElement.height),
    spaceScene.camera.fov * (Math.PI / 180),
  );

  return {
    spaceScene,
    visualSystem,
    starfield,
    lighting,
    cameraPositionKm: epochState.cameraPositionKm,
    positionsKm: epochState.positionsKm,
  };
}
