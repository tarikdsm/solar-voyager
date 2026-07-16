# T0013 Rails Propagation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compile the body catalog into allocation-free analytic rails and evaluate all heliocentric states at arbitrary J2026-relative times within the required accuracy and 50-body performance budget.

**Architecture:** A setup-only compiler validates parent order and converts catalog objects into structure-of-arrays float64 storage. A caller-owned state and workspace let `evaluateRailsInto` advance mean anomalies, reuse the existing Kepler conversion, and add already-evaluated parent states in one allocation-free pass; the state's timestamp provides the per-time cache.

**Tech Stack:** TypeScript ES2022, Float64Array/Int32Array, existing Kepler/orbital conversion modules, Vitest, baked JPL Horizons JSON.

## Global Constraints

- `src/sim/` remains pure TypeScript with no DOM, Three.js, I/O, or side effects.
- All physical state is IEEE-754 float64 in km, km/s, seconds, radians, and km³/s².
- The frame-loop evaluator performs zero allocations and resolves parents in one ordered pass.
- Mean-anomaly and state formulas cite and match `docs/physics-spec.md` section 2.
- Epoch positions for every baked non-root body must differ from Horizons by less than 1 km.
- A changing-time evaluation of 50 bodies must have median cost below 0.2 ms.
- Tests are written before production behavior and all repository gates pass before review.

---

### Task 1: Compile and validate rails catalog data

**Files:**
- Create: `src/sim/propagation/rails.ts`
- Create: `src/sim/propagation/rails.test.ts`

**Interfaces:**
- Consumes: `OrbitalElements` from `src/sim/bodies/orbitalElements.ts`.
- Produces: `RailsBodyInput`, `CompiledRailsCatalog`, and `compileRailsCatalog(bodies)`.

- [ ] **Step 1: Write failing compiler tests**

Add tests that compile a root plus nested bodies and assert ordered ids,
`parentIndices = [-1, 0, 1]`, copied GM/element arrays, and precomputed
`sqrt(muParent / abs(a)^3)`. Add table tests rejecting: empty input, duplicate
id, a root after index zero, two roots, missing/forward parent, null non-root
elements, non-positive GM, non-finite fields, elliptic `a <= 0`, hyperbolic
`a >= 0`, and `e === 1`.

```ts
const nested = [
  { id: 'sun', parentId: null, muKm3S2: 1000, elements: null },
  { id: 'planet', parentId: 'sun', muKm3S2: 10, elements: orbit(100, 0.1) },
  { id: 'moon', parentId: 'planet', muKm3S2: 1, elements: orbit(10, 0.01) },
] satisfies RailsBodyInput[];
const compiled = compileRailsCatalog(nested);
expect([...compiled.parentIndices]).toEqual([-1, 0, 1]);
expect(compiled.meanMotionRadS[2]).toBeCloseTo(Math.sqrt((10 + 1) / 10 ** 3), 15);
```

- [ ] **Step 2: Verify the tests fail for the missing module**

Run: `npx vitest run src/sim/propagation/rails.test.ts`

Expected: FAIL because `./rails.js` cannot be resolved.

- [ ] **Step 3: Implement the typed compiler**

Define the public input and SoA output with exact fields:

```ts
export interface RailsBodyInput {
  readonly id: string;
  readonly parentId: string | null;
  readonly muKm3S2: number;
  readonly elements: Readonly<OrbitalElements> | null;
}

export interface CompiledRailsCatalog {
  readonly bodyCount: number;
  readonly bodyIds: readonly string[];
  readonly parentIndices: Int32Array;
  readonly muKm3S2: Float64Array;
  readonly orbitalMuKm3S2: Float64Array;
  readonly meanMotionRadS: Float64Array;
  readonly semiMajorAxisKm: Float64Array;
  readonly eccentricity: Float64Array;
  readonly inclinationRad: Float64Array;
  readonly longitudeAscendingNodeRad: Float64Array;
  readonly argumentPeriapsisRad: Float64Array;
  readonly meanAnomalyAtEpochRad: Float64Array;
}
```

Allocate all arrays once. Populate an id-to-index `Map` only during setup.
Require the sole root at index zero with null elements. Resolve each non-root
parent from previously inserted ids, validate every numeric value with
`Number.isFinite`, validate `0 <= e < 1 && a > 0` or `e > 1 && a < 0`, then
precompute the relative two-body parameter and mean motion:

```ts
const absoluteSemiMajorAxisKm = Math.abs(elements.semiMajorAxisKm);
orbitalMuKm3S2[index] = parentMuKm3S2[index] + muKm3S2[index];
meanMotionRadS[index] = Math.sqrt(
  orbitalMuKm3S2[index] /
    (absoluteSemiMajorAxisKm * absoluteSemiMajorAxisKm * absoluteSemiMajorAxisKm),
);
```

- [ ] **Step 4: Run compiler tests and repository type/lint checks**

Run:

```text
npx vitest run src/sim/propagation/rails.test.ts
npm run typecheck
npm run lint
```

Expected: all pass.

- [ ] **Step 5: Commit compiler and validation**

```text
git add src/sim/propagation/rails.ts src/sim/propagation/rails.test.ts
git commit -m "feat(sim): [T0013] compile rails catalog"
```

### Task 2: Allocation-free one-pass state evaluation and cache

**Files:**
- Modify: `src/sim/propagation/rails.ts`
- Modify: `src/sim/propagation/rails.test.ts`

**Interfaces:**
- Consumes: Task 1 `CompiledRailsCatalog`; `createOrbitalElements`,
  `createCartesianState`, `createOrbitalConversionScratch`, and
  `elementsToStateInto`.
- Produces: `RailsState`, `RailsWorkspace`, `createRailsState(catalog)`,
  `createRailsWorkspace()`, and
  `evaluateRailsInto(state, catalog, timeSec, workspace)`.

- [ ] **Step 1: Write failing evaluation tests**

Add exact circular-orbit tests at epoch for a root, child, and grandchild. The
expected child state is its relative state plus the root; the grandchild is its
relative state plus the child. Test positive and negative time against direct
`elementsToStateInto` calls. Add one hyperbolic body and verify its mean anomaly
uses the same signed `n * timeSec` branch. Assert root zero state, stable output
array identities, and cache reuse by modifying one output value between two
same-time calls and observing that the second call returns without overwriting
it. A subsequent different-time call must recompute it. Reject NaN time and
state arrays whose lengths do not equal `bodyCount * 3`.

```ts
const state = createRailsState(catalog);
const workspace = createRailsWorkspace();
expect(evaluateRailsInto(state, catalog, 0, workspace)).toBe(state);
state.positionsKm[0] = 123;
evaluateRailsInto(state, catalog, 0, workspace);
expect(state.positionsKm[0]).toBe(123); // cache hit
evaluateRailsInto(state, catalog, 1, workspace);
expect(state.positionsKm[0]).toBe(0); // recomputed root
```

- [ ] **Step 2: Run evaluation tests and confirm missing exports fail**

Run: `npx vitest run src/sim/propagation/rails.test.ts`

Expected: FAIL because state/workspace/evaluation exports do not exist.

- [ ] **Step 3: Add caller-owned state and workspace factories**

```ts
export interface RailsState {
  timeSec: number;
  readonly positionsKm: Float64Array;
  readonly velocitiesKmS: Float64Array;
}

export interface RailsWorkspace {
  readonly elements: OrbitalElements;
  readonly relativeState: CartesianState;
  readonly conversion: OrbitalConversionScratch;
}
```

`createRailsState` returns `timeSec: Number.NaN` and two arrays of
`catalog.bodyCount * 3`. `createRailsWorkspace` calls the three existing
allocation factories once.

- [ ] **Step 4: Implement cached one-pass evaluation**

At function entry validate finite time and both output lengths, then return
immediately when `state.timeSec === timeSec`. Cite physics-spec.md section 2.
For each index, write the root as zeros or copy the compiled orbital fields into
the one scratch element object, set:

```ts
workspace.elements.meanAnomalyRad =
  catalog.meanAnomalyAtEpochRad[index] + catalog.meanMotionRadS[index] * timeSec;
```

Call `elementsToStateInto`, then write relative XYZ plus the parent's packed XYZ
for both position and velocity. Assign `state.timeSec = timeSec` only after the
complete pass. Use indexed `for` loops; create no literals, arrays, spreads,
callbacks, or closures in this function.

- [ ] **Step 5: Verify behavior and commit**

Run:

```text
npx vitest run src/sim/propagation/rails.test.ts
npm run typecheck
npm run lint
```

Expected: all pass.

```text
git add src/sim/propagation/rails.ts src/sim/propagation/rails.test.ts
git commit -m "feat(sim): [T0013] evaluate cached body rails"
```

### Task 3: Baked Horizons regression coverage

**Files:**
- Create: `tests/sim/propagation/rails.test.ts`

**Interfaces:**
- Consumes: Task 2 public rails API, `data/bodies.json`, and
  `data/ephemerides-check.json`.
- Produces: executable accuracy evidence for physics-spec.md section 2.

- [ ] **Step 1: Write the baked regression adapter and epoch test**

Import both JSON documents. Map catalog rows to `RailsBodyInput` using only
`id`, `parentId`, `muKm3S2`, and `elements`; compile and evaluate once at zero
seconds. For each body compute `Math.hypot(dx, dy, dz)` against sample zero and
assert `< 1` km with the body id in the assertion message.

```ts
const state = evaluateRailsInto(
  createRailsState(compiled),
  compiled,
  0,
  createRailsWorkspace(),
);
expect(positionErrorKm(state, index, checks.samples[0].states[bodyId]), bodyId).toBeLessThan(1);
```

- [ ] **Step 2: Add +30 d and +365 d class-bound regressions**

Evaluate at `offsetDays * 86_400`. For Moon and planets require `< 50_000 km`
at +30 d and `< 1_500_000 km` at +365 d. The Sun remains exactly zero. These
tolerances come directly from physics-spec.md section 2 as calibrated by
ADR-015 against the T0020 J2026 bake.

- [ ] **Step 3: Run regressions and diagnose only formula/data errors**

Run: `npx vitest run tests/sim/propagation/rails.test.ts`

Expected: PASS. Do not relax bounds; investigate any failure against the baked
frame, parent chain, units, and mean-motion formula.

- [ ] **Step 4: Commit baked regressions**

```text
git add tests/sim/propagation/rails.test.ts
git commit -m "test(sim): [T0013] verify rails against Horizons"
```

### Task 4: Enforce the 50-body performance budget

**Files:**
- Create: `tests/sim/propagation/rails.bench.test.ts`

**Interfaces:**
- Consumes: Task 2 public rails API and Node `performance.now()`.
- Produces: CI-enforced median full-catalog evaluation below 0.2 ms.

- [ ] **Step 1: Build a deterministic synthetic 50-body fixture**

Create one root and 49 elliptic bodies with unique ids, Sun parent, positive GM,
semimajor axes `50_000_000 + index * 5_000_000` km, eccentricities cycling
between `0.01` and `0.49`, and fixed finite angles. Construct, compile, allocate
state/workspace, and warm 500 changing-time evaluations outside measurement.

- [ ] **Step 2: Measure median changing-time cost**

Measure nine samples of 1,000 complete evaluations each. Advance time on every
call so the timestamp cache cannot short-circuit. Sort the nine numeric sample
values after measurement and assert sample four:

```ts
const medianMsPerEvaluation = samples.sort((a, b) => a - b)[4];
expect(medianMsPerEvaluation).toBeLessThan(0.2);
```

All fixture/sample allocations occur outside the measured evaluator call.

- [ ] **Step 3: Run benchmark repeatedly and the full test suite**

Run:

```text
npx vitest run tests/sim/propagation/rails.bench.test.ts
npx vitest run tests/sim/propagation/rails.bench.test.ts
npm test
```

Expected: both isolated runs and the full suite pass below 0.2 ms median.

- [ ] **Step 4: Commit the performance gate**

```text
git add tests/sim/propagation/rails.bench.test.ts
git commit -m "perf(sim): [T0013] enforce rails evaluation budget"
```

### Task 5: Final verification, review handoff, and PR

**Files:**
- Modify: `tasks/T0013-rails-propagation.yaml`

**Interfaces:**
- Consumes: all prior task outputs.
- Produces: task `REVIEW` state with exact accuracy/performance/gate evidence.

- [ ] **Step 1: Inspect the hot loop for allocation and layering violations**

Confirm `evaluateRailsInto` contains no `new`, array/object literals, spread,
array helpers, closures, map lookup, DOM, Three.js, or I/O. Confirm every parent
read targets an earlier packed state.

- [ ] **Step 2: Run all mandatory gates from a clean branch**

```text
npm run lint
npm run typecheck
npm run format:check
npm test
npm run test:tools
npm run build
npm run check:tasks
npm run check:budgets
git diff --check
```

Expected: all pass. Record total test counts, two benchmark passes, observed
median, and any non-blocking build advisory.

- [ ] **Step 3: Request independent code review and fix findings with TDD**

The reviewer checks physics-spec section 2 formulas/tolerances, topology,
float64 units, cache correctness, zero-allocation evaluation, hyperbolic and
negative-time behavior, baked data accuracy, and benchmark methodology. Resolve
all Critical/Important findings and rerun Step 2.

- [ ] **Step 4: Move T0013 to REVIEW with handoff evidence**

Set `status: REVIEW`. Preserve agent/branch and write `handoff_notes` containing
epoch maximum position error, +30/+365 maximum errors, benchmark median from two
runs, test counts, full gates, and review verdict.

```text
git add tasks/T0013-rails-propagation.yaml
git commit -m "chore(tasks): [T0013] move rails propagation to review"
```

- [ ] **Step 5: Rebase, verify, push, and open the PR**

Rebase on current `main`, rerun all gates, push
`task/T0013-rails-propagation`, and open PR title
`[T0013] Rails propagation of the body catalog`. The PR body maps both
acceptance criteria to the exact regression and benchmark evidence. A different
agent waits for green CI, changes the task to `DONE`, and merges without force.
