# T0014 N-body Gravity Field Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Evaluate the allocation-free Newtonian acceleration from every packed rails body and verify two-body truth plus Earth-Sun L1 equilibrium.

**Architecture:** One pure `src/sim/propagation/nbodyForces.ts` function consumes packed float64 GM/position arrays and writes into caller-owned acceleration storage. Scalar Kahan sums preserve cancellation accuracy without hot-path allocation; tests independently construct analytic and rotating-frame truth.

**Tech Stack:** TypeScript ES2022, Float64Array, Vitest, T0013 packed rails layout, baked J2026 body constants.

## Global Constraints

- `src/sim/` remains pure TypeScript: no DOM, Three.js, I/O, or side effects.
- Units are km, km/s², and km³/s² in binary64.
- The implementation matches physics-spec.md section 3 with all catalog bodies and no softening.
- The valid evaluator path allocates nothing and writes only caller-owned output.
- Production is inertial; centrifugal acceleration exists only in the rotating-frame L1 test.
- Test tolerances are added to physics-spec.md section 7 and justified by ADR-016 before delivery.
- All repository gates and independent review pass before merge.

---

### Task 1: Analytic allocation-free n-body acceleration

**Files:**
- Create: `src/sim/propagation/nbodyForces.ts`
- Create: `src/sim/propagation/nbodyForces.test.ts`

**Interfaces:**
- Consumes: T0013 `CompiledRailsCatalog.muKm3S2` and `RailsState.positionsKm`
  layout; arbitrary point arrays whose first three components are XYZ.
- Produces:
  `evaluateNBodyAccelerationInto(outputAccelerationKmS2, pointPositionKm, bodyMuKm3S2, bodyPositionsKm): Float64Array`.

- [ ] **Step 1: Write failing analytic and ownership tests**

Create a single Earth-like point mass at origin and evaluate at `[7000, 0, 0]`.
Assert x acceleration against `-μ/r²` with relative error below `1e-14`, y/z
exact zero, and returned identity equal to output. Add a non-axis 3D test whose
expected components are independently computed from the normalized relative
vector. Add two equal masses at `[-d,0,0]` and `[d,0,0]` and assert exact
cancellation at origin. Verify an empty body list overwrites prior output with
zeros and output may alias the point array.

```ts
const output = new Float64Array(3);
const returned = evaluateNBodyAccelerationInto(
  output,
  new Float64Array([7_000, 0, 0]),
  new Float64Array([398_600.435507]),
  new Float64Array([0, 0, 0]),
);
expect(returned).toBe(output);
expect(Math.abs((output[0] as number) / (-398_600.435507 / 7_000 ** 2) - 1)).toBeLessThan(1e-14);
```

- [ ] **Step 2: Write failing boundary/shape tests**

Assert an exact body-center evaluation writes `NaN` to all three components.
Assert descriptive errors for output length below three, point length below
three, and body-position length not equal to `bodyMuKm3S2.length * 3`.

- [ ] **Step 3: Run tests and observe the missing module failure**

Run: `npx vitest run src/sim/propagation/nbodyForces.test.ts`

Expected: FAIL because `./nbodyForces.js` cannot be resolved.

- [ ] **Step 4: Implement shape validation and scalar Kahan summation**

Implement the exact signature and return type. Read point XYZ into locals before
the loop. For each body compute:

```ts
const dxKm = bodyXKm - pointXKm;
const dyKm = bodyYKm - pointYKm;
const dzKm = bodyZKm - pointZKm;
const distanceSquaredKm2 = dxKm * dxKm + dyKm * dyKm + dzKm * dzKm;
const inverseDistanceCubedKm3 =
  1 / (distanceSquaredKm2 * Math.sqrt(distanceSquaredKm2));
const factorS2 = muKm3S2 * inverseDistanceCubedKm3;
```

If squared distance is zero, write three `Number.NaN` values and return. For
each acceleration component inline the Kahan update using scalar sum and
correction locals. After the loop write sums to output. Do not allocate inside
the function.

- [ ] **Step 5: Verify, inspect, and commit**

Run:

```text
npx vitest run src/sim/propagation/nbodyForces.test.ts
npm run typecheck
npm run lint
npm run format:check
```

Expected: all pass. Inspect the function for `new`, literals, spreads, array
helpers, closures, and callbacks on the valid path.

```text
git add src/sim/propagation/nbodyForces.ts src/sim/propagation/nbodyForces.test.ts
git commit -m "feat(sim): [T0014] evaluate n-body gravity field"
```

### Task 2: Specify and verify Earth-Sun L1 equilibrium

**Files:**
- Modify: `docs/physics-spec.md`
- Create: `docs/decisions/ADR-016-nbody-l1-validation-profile.md`
- Create: `tests/sim/propagation/nbodyForces.test.ts`

**Interfaces:**
- Consumes: Task 1 evaluator and Sun/Earth constants plus Earth's J2026
  semimajor axis from `data/bodies.json`.
- Produces: independent rotating-frame L1 regression and exact section-7
  tolerances.

- [ ] **Step 1: Add the validation profile to the spec and ADR**

Append physics-spec.md section 7 item 12:

```text
N-body field: single-body inverse-square relative error < 1e-14. In an ideal
circular Earth-Sun barycentric frame, solve L1 independently; its distance from
Earth is 1.4e6–1.6e6 km and |g_x+n²x| / max(|g_x|,|n²x|) < 1e-10.
```

ADR-016 records why these dimensionless/numeric tolerances are stable, that the
centrifugal term is test-only, and that no softening/collision convention is
introduced.

- [ ] **Step 2: Write the independent L1 regression**

Load Sun/Earth GM and Earth's semimajor axis from `bodies.json`. Construct
barycentric positions:

```ts
const totalMu = sunMu + earthMu;
const sunXKm = -separationKm * earthMu / totalMu;
const earthXKm = separationKm * sunMu / totalMu;
const meanMotionSquaredS2 = totalMu / separationKm ** 3;
```

Define a test-only scalar residual directly from the two inverse-square terms
plus `meanMotionSquaredS2 * xKm`; do not call the production evaluator while
solving. Bracket L1 using half/twice the Hill approximation
`a * cbrt(earthMu / (3 * sunMu))` and bisect 100 times. Assert distance from
Earth is within 1.4e6–1.6e6 km.

- [ ] **Step 3: Verify production acceleration at the independent root**

Call `evaluateNBodyAccelerationInto` once with the two packed bodies at the
independently solved x coordinate. Compute centrifugal acceleration separately
and assert the normalized residual below `1e-10`. Also assert y/z zero.

- [ ] **Step 4: Run focused/full tests and commit**

Run:

```text
npx vitest run src/sim/propagation/nbodyForces.test.ts tests/sim/propagation/nbodyForces.test.ts
npm test
npm run typecheck
npm run lint
npm run format:check
```

Expected: all pass.

```text
git add docs/physics-spec.md docs/decisions/ADR-016-nbody-l1-validation-profile.md tests/sim/propagation/nbodyForces.test.ts
git commit -m "test(sim): [T0014] verify Earth-Sun L1 equilibrium"
```

### Task 3: Independent review and delivery

**Files:**
- Modify: `tasks/T0014-nbody-forces.yaml`

**Interfaces:**
- Consumes: Tasks 1-2 deliverables.
- Produces: reviewed PR with T0014 in `REVIEW` and acceptance evidence.

- [ ] **Step 1: Run all mandatory gates sequentially**

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

Record total test counts, analytic relative error, L1 coordinate/distance and
normalized residual, plus the known Vite advisory if unchanged.

- [ ] **Step 2: Request independent review**

The reviewer checks formula sign/units, all-body iteration, Kahan correctness,
singularity behavior, aliasing, array validation, zero allocations, L1 frame
derivation, independent-root methodology, tolerances/ADR, layering, and gates.
Resolve all Critical/Important findings with a failing test first and repeat
Step 1.

- [ ] **Step 3: Move the task to REVIEW**

Set `status: REVIEW` and add handoff notes with both acceptance criteria,
numeric evidence, gate counts, review verdict, and any non-blocking advisory.

```text
git add tasks/T0014-nbody-forces.yaml
git commit -m "chore(tasks): [T0014] move n-body forces to review"
```

- [ ] **Step 4: Rebase, verify, push, and open PR**

Rebase onto current `main`, rerun all gates, push
`task/T0014-nbody-forces`, and open PR title
`[T0014] N-body gravity field evaluation`. The PR maps the analytic two-body and
Earth-Sun L1 criteria to exact results. A different agent waits for green CI,
changes the task to `DONE`, and merges without force.
