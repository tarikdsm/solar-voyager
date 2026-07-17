import { performance } from 'node:perf_hooks';

import { createServer } from 'vite';

const WARMUP_STEPS = 1_000;
const SAMPLE_STEPS = 10_000;
const MAX_RETAINED_HEAP_GROWTH_BYTES = 64 * 1024;

const server = await createServer({
  appType: 'custom',
  logLevel: 'silent',
  server: { middlewareMode: true },
});

try {
  const simulationModule = await server.ssrLoadModule('/src/game/createNewGameSimulation.ts');
  const core = simulationModule.createNewGameSimulation(10_000);
  const firstSnapshot = core.snapshot;
  const secondSnapshot = core.step(1 / 60);

  for (let index = 0; index < WARMUP_STEPS; index += 1) core.step(1 / 60);
  globalThis.gc?.();
  const heapBeforeBytes = process.memoryUsage().heapUsed;
  const startMs = performance.now();
  for (let index = 0; index < SAMPLE_STEPS; index += 1) core.step(1 / 60);
  const elapsedMs = performance.now() - startMs;
  globalThis.gc?.();
  const heapAfterBytes = process.memoryUsage().heapUsed;
  const retainedHeapGrowthBytes = heapAfterBytes - heapBeforeBytes;
  const usesExpectedSnapshot = core.snapshot === firstSnapshot || core.snapshot === secondSnapshot;
  const result = {
    warmupSteps: WARMUP_STEPS,
    sampleSteps: SAMPLE_STEPS,
    averageStepMs: elapsedMs / SAMPLE_STEPS,
    retainedHeapGrowthBytes,
    snapshotBuffers: usesExpectedSnapshot ? 2 : 'unexpected',
  };

  console.log(JSON.stringify(result, null, 2));
  if (!usesExpectedSnapshot) throw new Error('SimulationCore allocated an unexpected snapshot');
  if (retainedHeapGrowthBytes > MAX_RETAINED_HEAP_GROWTH_BYTES) {
    throw new Error(
      `SimulationCore retained ${String(retainedHeapGrowthBytes)} bytes after the sample window`,
    );
  }
} finally {
  await server.close();
}
