# Osculating Conic Overlay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render a stable analytic osculating ellipse or hyperbola around the dominant body with a single allocation-free `Line2`.

**Architecture:** Extend the compiled rails catalog with the already-authored SOI radii, then make osculating analysis retain a hysteretic dominant-body index. A pure render-layer sampler writes body-relative conic points into fixed float64 storage, and one setup-time `Line2` copies those points into its existing interleaved GPU buffer while a camera-relative anchor supplies the dominant body's heliocentric position.

**Tech Stack:** TypeScript, Vitest, Three.js `Line2`/`LineGeometry`/`LineMaterial`, Vite, Playwright browser smoke.

## Global Constraints

- `src/sim/` remains pure TypeScript with no Three.js, DOM, globals, or side effects.
- All physics inputs and conic calculations use float64 kilometres, kilometres per second, seconds, and km3/s2.
- `CameraRelativeSpaceScene` remains the only float64-to-float32 camera-relative boundary.
- The frame loop creates no arrays, objects, closures, materials, geometries, or strings.
- The overlay uses one draw call and one setup-time material/geometry with at most 256 segments.
- No `SimSnapshot`, `Commands`, `bodies.json` schema, or physics formula changes are introduced.

---

### Task 1: SOI-aware dominant-body hysteresis

**Files:**
- Modify: `src/sim/propagation/rails.ts`
- Create: `src/sim/analysis/dominantBody.ts`
- Create: `src/sim/analysis/dominantBody.test.ts`
- Modify: `src/sim/analysis/osculating.ts`
- Modify: `src/sim/analysis/osculating.test.ts`
- Modify: `src/sim/simulation.ts`
- Test: `src/sim/propagation/rails.test.ts`

**Interfaces:**
- Consumes: `RailsBodyInput.parentId`, `RailsBodyInput.muKm3S2`, and existing `soiRadiusKm` values from `data/bodies.json`.
- Produces: `CompiledRailsCatalog.soiRadiiKm: Float64Array` and `selectDominantBodyIndexWithHysteresis(shipState, bodyPositionsKm, catalog, previousIndex): number`.

- [ ] **Step 1: Write failing catalog and hysteresis tests**

```ts
it('compiles positive SOI radii and uses infinity for the root', () => {
  const catalog = compileRailsCatalog([
    { id: 'sun', parentId: null, muKm3S2: 100, soiRadiusKm: null, elements: null },
    { id: 'planet', parentId: 'sun', muKm3S2: 1, soiRadiusKm: 10, elements: orbit() },
  ]);
  expect(catalog.soiRadiiKm[0]).toBe(Number.POSITIVE_INFINITY);
  expect(catalog.soiRadiiKm[1]).toBe(10);
});

it('enters at 0.9 child SOI and exits only beyond 1.1 child SOI', () => {
  expect(selectDominantBodyIndexWithHysteresis(insideEntry, catalog, 0)).toBe(1);
  expect(selectDominantBodyIndexWithHysteresis(insideExitBand, catalog, 1)).toBe(1);
  expect(selectDominantBodyIndexWithHysteresis(outsideExit, catalog, 1)).toBe(0);
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npx vitest run src/sim/propagation/rails.test.ts src/sim/analysis/dominantBody.test.ts`

Expected: FAIL because `soiRadiiKm` and `selectDominantBodyIndexWithHysteresis` do not exist.

- [ ] **Step 3: Compile SOI storage and implement the selector**

```ts
export interface RailsBodyInput {
  readonly id: string;
  readonly parentId: string | null;
  readonly muKm3S2: number;
  readonly soiRadiusKm?: number | null;
  readonly elements: Readonly<OrbitalElements> | null;
}

export interface CompiledRailsCatalog {
  // existing fields...
  readonly soiRadiiKm: Float64Array;
}

export function selectDominantBodyIndexWithHysteresis(
  shipState: Float64Array,
  bodyPositionsKm: Float64Array,
  catalog: CompiledRailsCatalog,
  previousIndex: number,
): number {
  // Find the raw mu/d2 maximum without allocating. A descendant enters only
  // inside 0.9 SOI and at >1.1 current score; an ancestor reclaims only after
  // the current child exits 1.1 SOI; unrelated contenders require >1.1 score.
}
```

Store `Number.POSITIVE_INFINITY` for a null/missing root SOI, reject non-null
non-positive values, and walk `parentIndices` with indexed loops to classify
ancestor/descendant relationships.

- [ ] **Step 4: Make osculating analysis retain the selected index**

```ts
export interface OsculatingWorkspace {
  readonly relativeState: CartesianState;
  readonly elements: OrbitalElements;
  readonly keplerSolution: KeplerSolution;
  dominantBodyIndex: number;
}

export function updateOsculatingElements(
  snapshot: SimulationSnapshotBuffer,
  catalog: CompiledRailsCatalog,
  workspace: OsculatingWorkspace,
): void {
  const selected = selectDominantBodyIndexWithHysteresis(
    snapshot.shipState,
    snapshot.bodyPositionsKm,
    catalog,
    workspace.dominantBodyIndex,
  );
  workspace.dominantBodyIndex = selected;
  snapshot.dominantBodyIndex = selected;
  // existing element conversion remains unchanged
}
```

Update `SimulationCore` to pass `this.catalog` and update existing osculating
tests to compile their minimal catalogs.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `npx vitest run src/sim/propagation/rails.test.ts src/sim/analysis/dominantBody.test.ts src/sim/analysis/osculating.test.ts src/sim/simulation.test.ts`

Expected: all focused tests pass and the existing element values remain unchanged.

- [ ] **Step 6: Commit the analysis slice**

```bash
git add src/sim/propagation/rails.ts src/sim/propagation/rails.test.ts src/sim/analysis/dominantBody.ts src/sim/analysis/dominantBody.test.ts src/sim/analysis/osculating.ts src/sim/analysis/osculating.test.ts src/sim/simulation.ts
git commit -m "feat(sim): [T0057] stabilize dominant-body selection"
```

### Task 2: Allocation-free analytic conic sampler

**Files:**
- Create: `src/render/osculatingConicGeometry.ts`
- Create: `src/render/osculatingConicGeometry.test.ts`

**Interfaces:**
- Consumes: `Readonly<OsculatingElementsSnapshot>` from `src/sim/simulationSnapshot.ts`.
- Produces: `MAX_OSCULATING_CONIC_SEGMENTS`, `requiredOsculatingSegmentCount(elements)`, and `writeOsculatingConicPointsInto(outputKm, elements): number`.

- [ ] **Step 1: Write failing ellipse and hyperbola tests**

```ts
it('matches canonical two-body Cartesian points for a rotated ellipse', () => {
  const output = new Float64Array((MAX_OSCULATING_CONIC_SEGMENTS + 1) * 3);
  const pointCount = writeOsculatingConicPointsInto(output, snapshotElements);
  expect(pointCount).toBe(129);
  expectPointNearCanonicalState(output, 32, canonicalStateAtQuarterOrbit, 1e-8);
});

it('writes a finite open hyperbola without joining its endpoints', () => {
  const output = new Float64Array((MAX_OSCULATING_CONIC_SEGMENTS + 1) * 3);
  const pointCount = writeOsculatingConicPointsInto(output, hyperbolicElements);
  expect(pointCount).toBe(257);
  expect(allWrittenComponentsFinite(output, pointCount)).toBe(true);
  expect(endpointDistance(output, pointCount)).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run sampler tests and verify RED**

Run: `npx vitest run src/render/osculatingConicGeometry.test.ts`

Expected: FAIL because the sampler module does not exist.

- [ ] **Step 3: Implement the fixed-storage sampler**

```ts
export const MAX_OSCULATING_CONIC_SEGMENTS = 256;

export function requiredOsculatingSegmentCount(
  elements: Readonly<OsculatingElementsSnapshot>,
): number {
  if (!elements.valid) return 0;
  if (elements.eccentricity < 0.25) return 64;
  if (elements.eccentricity < 0.75) return 128;
  return 256;
}

export function writeOsculatingConicPointsInto(
  outputKm: Float64Array,
  elements: Readonly<OsculatingElementsSnapshot>,
): number {
  // Validate branch/output capacity, sample r=p/(1+e*cos(nu)), rotate with
  // Rz(Omega)*Rx(i)*Rz(omega), and return segments + 1 or zero.
}
```

For hyperbolas, derive the true-anomaly limit from `acos(-1/e)`, subtract a
small angular margin, and tighten it to a finite render radius cap before
sampling. Write every component by numeric index; do not create temporary
vectors or arrays.

- [ ] **Step 4: Run sampler tests and verify GREEN**

Run: `npx vitest run src/render/osculatingConicGeometry.test.ts`

Expected: ellipse points match the canonical converter and hyperbola points are finite and open.

- [ ] **Step 5: Commit the sampler**

```bash
git add src/render/osculatingConicGeometry.ts src/render/osculatingConicGeometry.test.ts
git commit -m "feat(render): [T0057] sample analytic osculating conics"
```

### Task 3: Single-buffer Line2 overlay

**Files:**
- Create: `src/render/osculatingConicOverlay.ts`
- Create: `src/render/osculatingConicOverlay.test.ts`

**Interfaces:**
- Consumes: `CameraRelativeSpaceScene`, `SimulationSnapshot`, and Task 2's sampler.
- Produces: `OsculatingConicOverlay.update(snapshot, viewportWidthPx, viewportHeightPx): void` and `readonly line: Line2` for setup-time integration and structural tests.

- [ ] **Step 1: Write failing stable-resource tests**

```ts
it('updates one Line2 buffer and anchor without replacing resources', () => {
  const overlay = new OsculatingConicOverlay(spaceScene);
  const geometry = overlay.line.geometry;
  const start = geometry.getAttribute('instanceStart');
  overlay.update(validSnapshot, 1920, 1080);
  overlay.update(validSnapshot, 1280, 720);
  expect(overlay.line.geometry).toBe(geometry);
  expect(geometry.getAttribute('instanceStart')).toBe(start);
  expect(geometry.instanceCount).toBeGreaterThanOrEqual(64);
});

it('hides invalid solutions without replacing buffers', () => {
  overlay.update(invalidSnapshot, 1920, 1080);
  expect(overlay.line.visible).toBe(false);
  expect(overlay.line.geometry.instanceCount).toBe(0);
});
```

- [ ] **Step 2: Run overlay tests and verify RED**

Run: `npx vitest run src/render/osculatingConicOverlay.test.ts`

Expected: FAIL because `OsculatingConicOverlay` does not exist.

- [ ] **Step 3: Build all Three.js resources at setup time**

```ts
export class OsculatingConicOverlay {
  readonly line: Line2;
  private readonly anchor = new Group();
  private readonly anchorPositionKm = { x: 0, y: 0, z: 0 };
  private readonly pointsKm = new Float64Array((MAX_OSCULATING_CONIC_SEGMENTS + 1) * 3);

  constructor(spaceScene: CameraRelativeSpaceScene) {
    const setupPositions = new Float32Array((MAX_OSCULATING_CONIC_SEGMENTS + 1) * 3);
    const geometry = new LineGeometry().setPositions(setupPositions);
    const material = new LineMaterial({ color: 0x55ddff, linewidth: 1.5, transparent: true, opacity: 0.72, depthWrite: false });
    this.line = new Line2(geometry, material);
    this.line.frustumCulled = false;
    this.anchor.add(this.line);
    spaceScene.bindVisual(this.anchor, this.anchorPositionKm);
  }
}
```

After construction, cache the shared `InstancedInterleavedBuffer` backing
`instanceStart`/`instanceEnd`. `update()` writes consecutive start/end pairs,
sets `instanceCount`, marks that cached buffer dirty, updates material
resolution, and toggles visibility. It does not call `setPositions()`.

- [ ] **Step 4: Run overlay and space-scene tests and verify GREEN**

Run: `npx vitest run src/render/osculatingConicOverlay.test.ts src/render/spaceScene.test.ts`

Expected: resources retain identity, the anchor is camera-relative, and invalid snapshots hide the overlay.

- [ ] **Step 5: Commit the renderer**

```bash
git add src/render/osculatingConicOverlay.ts src/render/osculatingConicOverlay.test.ts
git commit -m "feat(render): [T0057] render one camera-relative conic line"
```

### Task 4: Epoch-world and frame-loop integration

**Files:**
- Modify: `src/render/createEpochWorld.ts`
- Modify: `src/render/createEpochWorld.test.ts`
- Modify: `src/main.ts`

**Interfaces:**
- Consumes: `new OsculatingConicOverlay(spaceScene)` and its `update()` method.
- Produces: `EpochWorld.osculatingConic` and a live overlay updated from each `SimSnapshot` before camera-relative conversion.

- [ ] **Step 1: Write failing epoch-world integration assertion**

```ts
expect(world.osculatingConic.line.parent?.name).toBe('osculating-conic-anchor');
expect(world.spaceScene.scene.getObjectByName('osculating-conic')).toBe(world.osculatingConic.line);
```

- [ ] **Step 2: Run the integration test and verify RED**

Run: `npx vitest run src/render/createEpochWorld.test.ts`

Expected: FAIL because `EpochWorld.osculatingConic` does not exist.

- [ ] **Step 3: Wire setup and the frame update**

```ts
// createEpochWorld.ts
const osculatingConic = new OsculatingConicOverlay(spaceScene);
// include osculatingConic in the returned EpochWorld

// main.ts, before spaceScene.updateCameraRelative(cameraPositionKm)
osculatingConic.update(snapshot, canvas.width, canvas.height);
```

Keep construction before the final `renderer.compileAsync()` so `LineMaterial`
is compiled during loading. Run the unchanged render-depth regression as a
compatibility gate; its isolated fixture intentionally does not build
`EpochWorld`.

- [ ] **Step 4: Run focused integration and browser regression tests**

Run: `npx vitest run src/render/createEpochWorld.test.ts src/render/osculatingConicOverlay.test.ts`

Run: `npm run test:render-depth`

Expected: unit integration passes and both depth strategies retain clean occlusion.

- [ ] **Step 5: Commit runtime integration**

```bash
git add src/render/createEpochWorld.ts src/render/createEpochWorld.test.ts src/main.ts
git commit -m "feat(game): [T0057] integrate live osculating overlay"
```

### Task 5: Full verification and delivery

**Files:**
- Modify: `tasks/T0057-osculating-overlay.yaml`
- Modify only if required by verified behavior: `docs/rendering-spec.md`

**Interfaces:**
- Consumes: the completed analysis, sampler, renderer, and runtime integration.
- Produces: review evidence addressing both acceptance criteria and a clean PR branch.

- [ ] **Step 1: Run all local gates**

```bash
npm run lint
npm run typecheck
npm run format:check
npm test -- --run
npm run test:tools
npm run build
npm run check:budgets
npm run check:tasks
```

Expected: every command exits zero; no test count regresses and the critical path remains below 8 MiB.

- [ ] **Step 2: Run the real-browser playtest**

Start the Vite server, open the game through the Playwright workflow, confirm
that the conic is visible around Earth in the initial LEO scene, capture a
screenshot, and verify zero console errors. Record drawing-buffer dimensions,
line visibility, draw calls, and heap stability evidence.

- [ ] **Step 3: Record handoff evidence and move the task to REVIEW**

```yaml
status: REVIEW
handoff_notes: |
  Analytic Line2 overlay verified against canonical two-body conversion.
  SOI hysteresis remained stable across 0.9/1.1 entry/exit boundaries.
  One preallocated draw call, zero frame-loop resource creation; full gates and
  browser playtest passed.
```

- [ ] **Step 4: Commit delivery state**

```bash
git add tasks/T0057-osculating-overlay.yaml docs/rendering-spec.md
git commit -m "chore(tasks): [T0057] move osculating overlay to review"
```

- [ ] **Step 5: Push and open the PR**

```bash
git push -u origin task/T0057-osculating-overlay
gh pr create --draft --title "[T0057] Osculating conic overlay" --body "Implements the allocation-free Line2 osculating overlay and SOI hysteresis. Verification evidence is recorded in tasks/T0057-osculating-overlay.yaml."
```

The PR body must map the two acceptance criteria to the exact tests, browser
evidence, one-draw-call result, and before/after render telemetry.
