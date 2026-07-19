import bodiesDocument from '../../data/bodies.json';

import { build } from 'vite';
import { describe, expect, it } from 'vitest';

import { predictThrustFreeTrajectory } from '../../src/sim/analysis/trajectoryPredictor.js';
import { compileRailsCatalog } from '../../src/sim/propagation/rails.js';
import {
  PREDICTOR_POINT_STRIDE,
  PREDICTOR_POINT_TIME_SEC_OFFSET,
  PREDICTOR_POINT_X_KM_OFFSET,
  PREDICTOR_POINT_Y_KM_OFFSET,
  PREDICTOR_POINT_Z_KM_OFFSET,
} from '../../src/workers/predictorProtocol.js';
import {
  createGoldenScenario,
  GOLDEN_DURATION_SEC,
  GOLDEN_SAMPLE_INTERVAL_SEC,
  runGoldenTrajectory,
} from '../golden/goldenTrajectoryHarness.js';

const MAX_POSITION_ERROR_KM = 1;
const DAILY_POINT_COUNT = GOLDEN_DURATION_SEC / GOLDEN_SAMPLE_INTERVAL_SEC + 1;
const WORKER_BUILD_ENTRY_ID = 'virtual:predictor-worker-build-entry';
const RESOLVED_WORKER_BUILD_ENTRY_ID = `\0${WORKER_BUILD_ENTRY_ID}`;

function createCanonicalCollisionRadiiKm(): Float64Array {
  const collisionRadiiKm = new Float64Array(bodiesDocument.bodies.length);
  for (let bodyIndex = 0; bodyIndex < bodiesDocument.bodies.length; bodyIndex += 1) {
    const body = bodiesDocument.bodies[bodyIndex];
    if (body === undefined) throw new Error(`missing canonical body at index ${bodyIndex}`);
    collisionRadiiKm[bodyIndex] = body.meanRadiusKm + (body.surface.atmosphereTopKm ?? 0);
  }
  return collisionRadiiKm;
}

describe('predictor worker accuracy — physics-spec.md §6', () => {
  it('stays within 1 km of independent main-thread propagation throughout 30-day LEO', () => {
    const scenario = createGoldenScenario('leo-30d');
    const reference = runGoldenTrajectory(scenario);
    const catalog = compileRailsCatalog(bodiesDocument.bodies);
    const earthIndex = catalog.bodyIds.indexOf('earth');
    expect(earthIndex).toBeGreaterThanOrEqual(0);

    const prediction = predictThrustFreeTrajectory({
      catalog,
      collisionRadiiKm: createCanonicalCollisionRadiiKm(),
      startTimeSec: 0,
      horizonSec: GOLDEN_DURATION_SEC,
      shipState: new Float64Array(scenario.initialState),
      dominantBodyIndex: earthIndex,
      outputPointCount: DAILY_POINT_COUNT,
    });

    expect(prediction.points).toHaveLength(reference.samples.length * PREDICTOR_POINT_STRIDE);
    let maxPositionErrorKm = 0;
    for (let sampleIndex = 0; sampleIndex < reference.samples.length; sampleIndex += 1) {
      const sample = reference.samples[sampleIndex];
      if (sample === undefined) throw new Error(`missing reference sample ${sampleIndex}`);
      const pointOffset = sampleIndex * PREDICTOR_POINT_STRIDE;
      expect(prediction.points[pointOffset + PREDICTOR_POINT_TIME_SEC_OFFSET]).toBe(sample.timeSec);

      const dxKm =
        (prediction.points[pointOffset + PREDICTOR_POINT_X_KM_OFFSET] as number) -
        (sample.state[0] as number);
      const dyKm =
        (prediction.points[pointOffset + PREDICTOR_POINT_Y_KM_OFFSET] as number) -
        (sample.state[1] as number);
      const dzKm =
        (prediction.points[pointOffset + PREDICTOR_POINT_Z_KM_OFFSET] as number) -
        (sample.state[2] as number);
      maxPositionErrorKm = Math.max(maxPositionErrorKm, Math.hypot(dxKm, dyKm, dzKm));
    }

    console.info(`predictor 30-day LEO max position error: ${maxPositionErrorKm} km`);
    expect(maxPositionErrorKm).toBeLessThanOrEqual(MAX_POSITION_ERROR_KM);
  }, 30_000);
});

describe('predictor worker Vite build integration', () => {
  it('processes predictor.worker.ts as a separate module-worker asset', async () => {
    const result = await build({
      configFile: false,
      root: process.cwd(),
      base: '/solar-voyager/',
      logLevel: 'silent',
      plugins: [
        {
          name: 'predictor-worker-build-fixture',
          resolveId(id) {
            return id === WORKER_BUILD_ENTRY_ID ? RESOLVED_WORKER_BUILD_ENTRY_ID : null;
          },
          load(id) {
            return id === RESOLVED_WORKER_BUILD_ENTRY_ID
              ? "new Worker(new URL('/src/workers/predictor.worker.ts', import.meta.url), { type: 'module' });"
              : null;
          },
        },
      ],
      build: {
        write: false,
        rollupOptions: { input: WORKER_BUILD_ENTRY_ID },
      },
    });
    if (!('output' in result)) throw new Error('unexpected Vite watch result');

    const entryChunk = result.output.find((output) => output.type === 'chunk' && output.isEntry);
    const workerAsset = result.output.find(
      (output) =>
        output.type === 'asset' && /^assets\/predictor\.worker-[\w-]+\.js$/.test(output.fileName),
    );
    expect(entryChunk?.type).toBe('chunk');
    expect(workerAsset?.type).toBe('asset');
    if (entryChunk?.type !== 'chunk' || workerAsset?.type !== 'asset') {
      throw new Error('Vite did not emit the predictor module worker');
    }

    expect(entryChunk.code).toContain(`/solar-voyager/${workerAsset.fileName}`);
    expect(entryChunk.code).toMatch(/type:[`'"]module/);
    const workerSource =
      typeof workerAsset.source === 'string'
        ? workerAsset.source
        : new TextDecoder().decode(workerAsset.source);
    expect(workerSource).toContain('addEventListener');
    expect(workerSource).toContain('trajectory prediction failed');
  });
});
