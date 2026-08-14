import { performance } from 'node:perf_hooks';

import { createServer } from 'vite';

const WARMUP_STEPS = 1_000;
const SAMPLE_STEPS = 10_000;
const FRAME_SEC = 1 / 60;
const MAX_RETAINED_HEAP_GROWTH_BYTES = 64 * 1024;
/**
 * Per-frame mouse travel for the flight-controller arm.
 *
 * Large enough that the pursuit never reaches its settle deadband, so every
 * branch of `FlightController.update()` runs on every sampled frame instead of
 * short-circuiting into the "nothing changed" path.
 */
const LOOK_DELTA_RAD = 4e-4;

/** Runs `step` for the warm-up then the sample window, returning ms per frame. */
function measureStepMs(step) {
  for (let index = 0; index < WARMUP_STEPS; index += 1) step();
  const startMs = performance.now();
  for (let index = 0; index < SAMPLE_STEPS; index += 1) step();
  return (performance.now() - startMs) / SAMPLE_STEPS;
}

const server = await createServer({
  appType: 'custom',
  logLevel: 'silent',
  server: { middlewareMode: true },
});

try {
  const simulationModule = await server.ssrLoadModule('/src/game/createNewGameSimulation.ts');
  const vesselModule = await server.ssrLoadModule('/src/sim/ship/vessel.ts');
  const controllerModule = await server.ssrLoadModule('/src/game/flight/flightController.ts');
  const routerModule = await server.ssrLoadModule('/src/game/flight/flightInputRouter.ts');
  const snapshotModule = await server.ssrLoadModule('/src/sim/simulationSnapshot.ts');
  // Each arm gets a fresh core from the same initial state. Sharing one core
  // would leave later arms measuring a ship that the earlier arms had already
  // boosted out of LEO, where the adaptive step count is different.
  const createCore = () => simulationModule.createNewGameSimulation(vesselModule.DEFAULT_VESSEL);

  // Arm A — the historical figure: `SimulationCore.step` alone in a prograde
  // hold. Kept identical so `averageStepMs` stays comparable across summaries.
  const holdCore = createCore();
  holdCore.commands.setAttitudeMode('prograde');
  holdCore.commands.setThrottle(0.5);
  holdCore.step(FRAME_SEC);
  const averageStepMs = measureStepMs(() => holdCore.step(FRAME_SEC));

  // Arm B — what T0108 actually adds to the frame loop, in isolation:
  // `router.apply` + `controller.update` against a snapshot that never moves.
  // Measured on its own rather than by differencing two `core.step` arms,
  // because the controller steers and two arms that steer differently fly
  // different trajectories, and DP54's adaptive step count follows the
  // trajectory — the difference would be dominated by that, not by this code.
  // The look delta alternates sign so the pursuit error stays small and the
  // full unsaturated path runs every frame.
  const stubSnapshot = snapshotModule.createSimulationSnapshotBuffer(['earth']);
  const stubCommands = snapshotModule.createCommandController(['earth']).commands;
  const stubPorts = {
    commands: stubCommands,
    snapshot: () => stubSnapshot,
    vessel: vesselModule.DEFAULT_VESSEL,
  };
  const stubController = new controllerModule.FlightController(stubPorts);
  const stubRouter = new routerModule.FlightInputRouter(stubController, stubPorts);
  const stubFrame = {
    lookYawRad: LOOK_DELTA_RAD,
    lookPitchRad: -LOOK_DELTA_RAD,
    axes: { pitch: 0, yaw: 0, roll: 0, throttle: 0.5 },
    pressed: () => false,
    pressCount: () => 0,
    held: () => false,
  };
  let lookSign = 1;
  const averageControllerMs = measureStepMs(() => {
    lookSign = -lookSign;
    stubFrame.lookYawRad = LOOK_DELTA_RAD * lookSign;
    stubFrame.lookPitchRad = -LOOK_DELTA_RAD * lookSign;
    stubRouter.apply(stubFrame);
    stubController.update(FRAME_SEC);
  });

  // Arm C — the frame loop as `main.ts` runs it (T0108):
  // `router.apply(poll()) -> controller.update() -> core.step()`. The stub frame
  // stands in for `InputEngine.poll()`, which T0105 already proved
  // allocation-free; every object here is created once, outside the loop.
  const core = createCore();
  const firstSnapshot = core.snapshot;
  const secondSnapshot = core.step(FRAME_SEC);
  const ports = { commands: core.commands, snapshot: () => core.snapshot, vessel: core.vessel };
  const controller = new controllerModule.FlightController(ports);
  const router = new routerModule.FlightInputRouter(controller, ports);
  const inputFrame = {
    lookYawRad: LOOK_DELTA_RAD,
    lookPitchRad: -LOOK_DELTA_RAD,
    axes: { pitch: 0, yaw: 0, roll: 0, throttle: 0.5 },
    pressed: () => false,
    pressCount: () => 0,
    held: () => false,
  };
  const flightStep = () => {
    router.apply(inputFrame);
    controller.update(FRAME_SEC);
    core.step(FRAME_SEC);
  };

  for (let index = 0; index < WARMUP_STEPS; index += 1) flightStep();
  globalThis.gc?.();
  const heapBeforeBytes = process.memoryUsage().heapUsed;
  const startMs = performance.now();
  for (let index = 0; index < SAMPLE_STEPS; index += 1) flightStep();
  const averageFlightStepMs = (performance.now() - startMs) / SAMPLE_STEPS;
  globalThis.gc?.();
  const heapAfterBytes = process.memoryUsage().heapUsed;
  const retainedHeapGrowthBytes = heapAfterBytes - heapBeforeBytes;
  const usesExpectedSnapshot = core.snapshot === firstSnapshot || core.snapshot === secondSnapshot;
  const result = {
    warmupSteps: WARMUP_STEPS,
    sampleSteps: SAMPLE_STEPS,
    averageStepMs,
    averageControllerMs,
    averageFlightStepMs,
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
