# Trajectory Rendering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the production predictor worker into the game and render its
camera-relative, body-colored path with event markers, closest-approach data,
and an impact warning.

**Architecture:** A pure game-layer decoder maps packed float64 worker results
into caller-owned segment/marker storage. `CameraRelativeSpaceScene` remains
the only float64-to-float32 bridge, while one preallocated `Line2` and one
preallocated `Points` batch render the result. Main owns the worker/client
lifecycle and publishes summaries to a small Preact signal store.

**Tech Stack:** TypeScript 6, Three.js r185 `Line2`/`LineGeometry`/
`LineMaterial`, WebGL `Points` shader, Preact signals, Vite module workers,
Vitest, Playwright.

## Global constraints

- Follow RED -> GREEN -> REFACTOR for every production change.
- Do not change `SimSnapshot`, `Commands`, the body schema, or physics formulas.
- Keep the single float64-to-float32 position boundary in
  `src/render/spaceScene.ts`.
- Create no geometry, material, typed array, object, or closure in the frame
  loop.
- Use at most two prediction draw calls and at most 2,000 line points.
- Precompile line and marker shaders before gameplay.
- Record before/after `npm run bench` evidence because render/frame-loop files
  change.

---

### Task 1: Packed prediction presentation model

**Files:**

- Create: `src/game/trajectoryPredictionModel.ts`
- Create: `src/game/trajectoryPredictionModel.test.ts`

**Interfaces:**

- Consumes: `PredictorSuccessMessage`, predictor point/event offsets and
  `PredictorEventCode` from `src/workers/predictorProtocol.ts`.
- Produces:

```ts
export interface TrajectoryEventSummary {
  closestApproachBodyIndex: number;
  closestApproachTimeSec: number;
  closestApproachDistanceKm: number;
  impactBodyIndex: number;
  impactTimeSec: number;
}

export function writePredictionPointsInto(
  outputPositionsKm: Float64Array,
  packedPoints: Float64Array,
): number;

export function writeTrajectoryMarkersInto(
  outputPositionsKm: Float64Array,
  outputCodes: Float32Array,
  outputBodyIndices: Float32Array,
  packedPoints: Float64Array,
  packedEvents: Float64Array,
): number;

export function writeTrajectorySegmentBodiesInto(
  outputBodyIndices: Int32Array,
  packedPoints: Float64Array,
  packedEvents: Float64Array,
  fallbackDominantBodyIndex: number,
): number;

export function readTrajectoryEventSummary(
  packedEvents: Float64Array,
): TrajectoryEventSummary;
```

- [ ] **Step 1: Write the failing decoder tests**

  Cover exact event-time matches, interpolation halfway between two samples,
  rejection outside the point interval, unsorted closest-approach records,
  SOI color switches, and impact/approach summary selection. Use a three-point
  fixture with times `0, 10, 20` and positions `(0,0,0), (10,20,30),
  (20,40,60)` so interpolation has unambiguous expected values.

- [ ] **Step 2: Verify RED**

  Run `npx vitest run src/game/trajectoryPredictionModel.test.ts`.
  Expected: FAIL because `trajectoryPredictionModel.ts` does not exist.

- [ ] **Step 3: Implement the decoder**

  Validate storage lengths and packed strides, copy xyz triples without
  changing float64 precision, binary-search point times for each event, and
  write interpolated xyz values into the caller-owned marker buffer. Process
  the chronologically emitted SOI subset with one forward cursor while walking
  segment start times; ignore interleaved non-SOI records so the pass stays
  O(points + events) even though the final closest-approach record may have an
  earlier timestamp. Return `-1`/`NaN` summary defaults when an event class is
  absent.

- [ ] **Step 4: Verify GREEN and commit**

  Run `npx vitest run src/game/trajectoryPredictionModel.test.ts`, then commit
  with `feat(game): [T0071] decode trajectory presentation data`.

### Task 2: Camera-relative packed Line2 binding

**Files:**

- Modify: `src/render/spaceScene.ts`
- Modify: `src/render/spaceScene.test.ts`

**Interfaces:**

- Produces:

```ts
export interface PackedPolylineBinding {
  readonly maximumPointCount: number;
  readonly pointCount: number;
  setPointCount(pointCount: number): void;
}

CameraRelativeSpaceScene.bindPackedPolyline(
  line: Line2,
  positionsKm: Float64Array,
): PackedPolylineBinding;
```

- [ ] **Step 1: Write failing camera-boundary tests**

  Create a four-point maximum buffer and a `Line2` initialized with matching
  setup positions. Bind it, activate three points, call
  `updateCameraRelative()` at two camera offsets, and assert the same
  `InstancedInterleavedBuffer` now contains the expected six-component segment
  pairs. Assert `instanceCount === 2`, inactive storage is untouched, the
  buffer identity is stable, and invalid point counts throw.

- [ ] **Step 2: Verify RED**

  Run `npx vitest run src/render/spaceScene.test.ts`.
  Expected: FAIL because `bindPackedPolyline` is absent.

- [ ] **Step 3: Implement the binding inside the sole boundary**

  Extract and retain `instanceStart.data`, validate a maximum-sized xyz
  float64 source, and write active start/end pairs with
  `Math.fround(source - cameraPosition)` during the existing frame update.
  Reuse the geometry bounding sphere and update its center/radius from active
  camera-relative points. Extend `unbindVisual()` to remove the binding.

- [ ] **Step 4: Verify GREEN and commit**

  Run `npx vitest run src/render/spaceScene.test.ts
  tests/render/float32Boundary.test.ts`, then commit with
  `feat(render): [T0071] bind camera-relative trajectory lines`.

### Task 3: Preallocated trajectory overlay and marker shader

**Files:**

- Create: `src/render/trajectoryOverlay.ts`
- Create: `src/render/trajectoryOverlay.test.ts`
- Modify: `src/render/createEpochWorld.ts`
- Modify: `src/render/createEpochWorld.test.ts`

**Interfaces:**

- Produces:

```ts
export class TrajectoryOverlay {
  readonly line: Line2;
  readonly markers: Points;
  readonly startTimeSec: number;
  readonly sampleIntervalSec: number;
  constructor(spaceScene: CameraRelativeSpaceScene, bodyIds: readonly string[]);
  applyPrediction(
    result: PredictorSuccessMessage,
    fallbackDominantBodyIndex: number,
  ): void;
  hide(): void;
  setViewport(widthPx: number, heightPx: number, pixelRatio: number): void;
  dispose(): void;
}
```

- Adds `readonly trajectoryOverlay: TrajectoryOverlay` to `EpochWorld`.

- [ ] **Step 1: Write failing resource and mapping tests**

  Assert construction creates one hidden `Line2` and one hidden `Points`, both
  with maximum-sized dynamic attributes and no per-event objects. Apply a
  fixture containing two SOI transitions plus all marker classes and assert
  point count, segment colors, marker types/positions, draw range, visible
  state, viewport uniforms, stable resource identities across a second result,
  and disposal. Assert `createEpochWorld()` registers and precompiles both
  objects.

- [ ] **Step 2: Verify RED**

  Run `npx vitest run src/render/trajectoryOverlay.test.ts
  src/render/createEpochWorld.test.ts`.
  Expected: FAIL because `TrajectoryOverlay` and the world field are absent.

- [ ] **Step 3: Implement setup-only resources**

  Initialize `LineGeometry` once with 2,000 zero points and once with matching
  color storage, retain its interleaved position/color buffers, enable
  `LineMaterial.vertexColors`, and bind the line through Task 2. Initialize one
  `BufferGeometry` with 2,002 position/code/body attributes and a shader that
  uses `gl_PointCoord` for ring, diamond, and warning-triangle silhouettes.
  Bind marker positions through `bindPackedPointPositions`, set draw ranges
  instead of replacing attributes, and precompute deterministic body-ID palette
  colors in the constructor rather than during the first worker response.

- [ ] **Step 4: Verify GREEN and commit**

  Run the focused render tests and commit with
  `feat(render): [T0071] render predicted trajectory and events`.

### Task 4: Trajectory HUD signals and impact warning

**Files:**

- Create: `src/ui/trajectoryPredictionSignals.ts`
- Create: `src/ui/trajectoryPredictionSignals.test.ts`
- Create: `src/ui/TrajectoryImpactWarning.tsx`
- Modify: `src/ui/App.tsx`
- Modify: `src/ui/app.css`

**Interfaces:**

- Produces:

```ts
export interface TrajectoryPredictionSignalStore {
  readonly display: {
    readonly nextClosestApproach: ReadonlySignal<string>;
    readonly impactMessage: ReadonlySignal<string>;
    readonly impactVisible: ReadonlySignal<boolean>;
  };
  publishPending(targetBodyIndex: number): void;
  publishSuccess(
    summary: TrajectoryEventSummary,
    bodyIds: readonly string[],
    currentSimTimeSec: number,
  ): void;
  publishError(): void;
  publishTime(simTimeSec: number, nowMs: number): boolean;
}
```

- Adds an optional `trajectoryPrediction` prop to `App`; `TargetPanel` consumes
  its closest-approach display and `TrajectoryImpactWarning` consumes its impact
  signals.

- [ ] **Step 1: Write failing signal/component tests**

  Prove no-target em dash, pending text, distance/countdown formatting,
  10 Hz countdown sampling, impact body naming/visibility, and error clearing.
  Keep component wiring assertions for the real-browser regression in Task 6;
  the focused unit test verifies every signal transition without a DOM shim.

- [ ] **Step 2: Verify RED**

  Run `npx vitest run src/ui/trajectoryPredictionSignals.test.ts`.
  Expected: FAIL because the store and component do not exist.

- [ ] **Step 3: Implement the signal graph and accessible warning**

  Reuse the project's English duration/distance formats, sample only time at
  100 ms, use `role="alert"` and `aria-live="assertive"`, and toggle only the
  signal-backed text/visibility. Style the warning with fixed positioning,
  `contain: strict`, and opacity/transform transitions only.

- [ ] **Step 4: Verify GREEN and commit**

  Run the focused UI tests and commit with
  `feat(ui): [T0071] surface trajectory events and impact warning`.

### Task 5: Production worker lifecycle and invalidation scheduler

**Files:**

- Modify: `src/game/createNewGameSimulation.ts`
- Modify: `src/game/createNewGameSimulation.test.ts`
- Create: `src/game/trajectoryPredictionRefresh.ts`
- Create: `src/game/trajectoryPredictionRefresh.test.ts`
- Modify: `src/main.ts`

**Interfaces:**

- Simulation factories accept an optional existing
  `TrajectoryInvalidationListener` and pass it to `SimulationCore`.
- Produces:

```ts
export class TrajectoryPredictionRefresh {
  acceptPrediction(points: Float64Array): void;
  update(simTimeSec: number, invalidateForWarpElapsed: () => void): void;
}
```

  `acceptPrediction()` stores first time and positive sample interval;
  `update()` invalidates once after one interval and remains latched until the
  next accepted prediction.

- [ ] **Step 1: Write failing factory and scheduler tests**

  Assert throttle/target commands on both new and restored simulations call the
  supplied listener. Assert the refresh scheduler ignores pre-threshold time,
  fires exactly once past one sample interval, does not reset a debounce every
  frame, and rearms on a new result.

- [ ] **Step 2: Verify RED**

  Run `npx vitest run src/game/createNewGameSimulation.test.ts
  src/game/trajectoryPredictionRefresh.test.ts`.
  Expected: FAIL because the factory parameter and scheduler are absent.

- [ ] **Step 3: Implement runtime wiring**

  In `main.ts`, construct the module worker and owning client once, pass one
  stable invalidation callback into all simulation factories, invalidate the
  initial prediction after world setup, and call `client.update(snapshot)` plus
  the refresh scheduler in the frame loop. On success, update overlay, summary
  signals, and scheduler in one callback; on error, publish unavailable state.
  Pass the signal store to `App`, update overlay viewport on resize, and dispose
  the client on `pagehide` with one stable listener.

- [ ] **Step 4: Verify GREEN and commit**

  Run all focused game/render/UI tests, `npm run typecheck`, and `npm run build`.
  Confirm Vite emits a separate `predictor.worker-*.js` asset. Commit with
  `feat(game): [T0071] integrate live trajectory prediction`.

### Task 6: Browser acceptance, performance evidence, and delivery

**Files:**

- Create: `tests/render/trajectoryOverlay.html`
- Create: `tests/render/trajectoryOverlayPage.ts`
- Create: `tools/tests/trajectoryOverlayRegression.mjs`
- Modify: `package.json`
- Create: `docs/bench/T0071-summary.md`
- Modify: `tasks/T0071-trajectory-rendering.yaml`

- [ ] **Step 1: Capture the unchanged-main baseline**

  Before production implementation, run `npm run bench` at `b2fd514` and record
  median/p75/p99 frame time, draw calls, triangles, and heap growth in the bench
  summary. If the benchmark emits its standard JSON artifact, preserve its
  exact values rather than manually rounding them.

- [ ] **Step 2: Write the failing browser regression**

  Load the test page with the real overlay, inject a deterministic packed
  prediction, and query projected line/marker coordinates before and after
  camera zoom. Expected RED: the page and `test:trajectory-overlay` script do
  not exist.

- [ ] **Step 3: Implement and run browser verification**

  Add the page/script and package command, assert every event marker projects
  onto its expected polyline point within one CSS pixel at both zoom levels,
  assert exactly two prediction draw calls at most, and fail on console/page
  errors. Run `npm run test:trajectory-overlay` and the production playtest
  skill.

- [ ] **Step 4: Capture post-change benchmark evidence**

  Run `npm run bench` on the final branch, compare against the baseline, and
  record exact deltas plus the enforced budget results in
  `docs/bench/T0071-summary.md`.

- [ ] **Step 5: Run full gates**

  Run `npm run lint`, `npm run typecheck`, `npm run format:check`,
  `npm test -- --run`, `npm run test:tools`, `npm run build`,
  `npm run check:budgets`, `npm run check:tasks`, `npm run test:smoke`, and
  `npm run test:perf-gates`. Expected: every command exits 0 with no new browser
  errors or budget regression.

- [ ] **Step 6: Review and deliver**

  Move T0071 to REVIEW with exact acceptance/benchmark evidence, obtain an
  independent whole-branch review, fix every finding through RED/GREEN cycles,
  push, open PR `[T0071] Trajectory polyline + event markers rendering`, wait
  for green CI, then mark DONE and merge normally.
