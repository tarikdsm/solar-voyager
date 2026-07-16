# DP54 Adaptive Integrator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a generic, allocation-free Dormand-Prince 5(4) propagator that satisfies physics-spec.md sections 3.1, 3.2, and 7.2.

**Architecture:** Add one pure `src/sim/propagation/dp54.ts` module. The public `propagate` function writes into caller-owned `Float64Array` state, workspace, and result objects so SimulationCore and the predictor worker can share it without frame-loop allocations. The result exposes accepted/rejected counts, reached time, next suggested step, budget exhaustion, and step underflow.

**Tech Stack:** TypeScript ES2022, Float64Array, Vitest.

## Global Constraints

- `src/sim/` remains pure TypeScript with no DOM, three.js, I/O, globals, or side effects.
- State, tableau constants, stages, error estimates, and time values remain IEEE-754 float64.
- DP54 uses the published Dormand-Prince 5(4) tableau, FSAL reuse, and the exact controller `h_new = h * min(5, max(0.2, 0.9 * (1/err)^(1/5)))`.
- Default ship tolerances are relative `1e-9`, position absolute `1e-6 km`, celerity absolute `1e-9 km/s`, and proper-time absolute `1e-6 s`.
- The per-frame interface must stop after 4,000 accepted steps and report that the requested horizon was not reached.
- No allocations occur inside `propagate` or derivative calls; all typed arrays and metadata are created before propagation.

---

### Task 1: Public caller-owned API and zero/constant derivatives

**Files:**
- Create: `src/sim/propagation/dp54.ts`
- Create: `src/sim/propagation/dp54.test.ts`

**Interfaces:**
- Consumes: `Float64Array` state vectors and a derivative callback `(timeSec, state, outputDerivative) => void`.
- Produces: `createDp54Workspace`, `createDp54Result`, `createShipDp54Tolerance`, and allocation-free `propagate`.

- [ ] **Step 1: Write failing API and constant-derivative tests**

```ts
import { describe, expect, it } from 'vitest';
import {
  createDp54Result,
  createDp54Workspace,
  propagate,
  type Dp54Tolerance,
} from './dp54.js';

const tolerance: Dp54Tolerance = {
  absolute: new Float64Array([1e-12]),
  relative: 1e-12,
  initialStepSec: 0.25,
  maxAcceptedSteps: 4_000,
};

describe('dp54 — physics-spec.md §3.1 / §3.2', () => {
  it('returns the initial state for a zero-length horizon', () => {
    const initial = new Float64Array([3]);
    const output = new Float64Array(1);
    const result = createDp54Result();
    propagate(output, initial, 5, 5, (_t, _state, derivative) => {
      derivative[0] = 99;
    }, tolerance, createDp54Workspace(1), result);

    expect(output[0]).toBe(3);
    expect(result.reachedEnd).toBe(true);
    expect(result.acceptedSteps).toBe(0);
  });

  it('integrates a constant derivative forward and backward', () => {
    for (const endTimeSec of [2, -2]) {
      const output = new Float64Array(1);
      const result = createDp54Result();
      propagate(output, new Float64Array([1]), 0, endTimeSec, (_t, _state, derivative) => {
        derivative[0] = 2;
      }, tolerance, createDp54Workspace(1), result);

      expect(output[0]).toBeCloseTo(1 + 2 * endTimeSec, 12);
      expect(result.reachedTimeSec).toBe(endTimeSec);
      expect(result.reachedEnd).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx vitest run src/sim/propagation/dp54.test.ts`

Expected: FAIL because `src/sim/propagation/dp54.ts` does not exist.

- [ ] **Step 3: Add interfaces, factories, published tableau, and propagation skeleton**

```ts
// physics-spec.md §3.1 — Dormand-Prince 5(4), Hairer-Nørsett-Wanner tableau.
export type Dp54Derivative = (
  timeSec: number,
  state: Float64Array,
  outputDerivative: Float64Array,
) => void;

export interface Dp54Tolerance {
  readonly absolute: Float64Array;
  relative: number;
  initialStepSec: number;
  maxAcceptedSteps: number;
}

export interface Dp54Result {
  reachedTimeSec: number;
  acceptedSteps: number;
  rejectedSteps: number;
  nextStepSec: number;
  reachedEnd: boolean;
  budgetExhausted: boolean;
  stepUnderflow: boolean;
}

export interface Dp54Workspace {
  readonly dimension: number;
  readonly stageState: Float64Array;
  readonly fourthOrderState: Float64Array;
  readonly fifthOrderState: Float64Array;
  readonly k1: Float64Array;
  readonly k2: Float64Array;
  readonly k3: Float64Array;
  readonly k4: Float64Array;
  readonly k5: Float64Array;
  readonly k6: Float64Array;
  readonly k7: Float64Array;
}
```

Implement `createDp54Workspace(dimension)`, `createDp54Result()`, and `propagate(...)`. Copy initial state into output, calculate all seven stages with indexed loops, accept when maximum normalized component error is at most one, clip the final step to the horizon, preserve direction for backward propagation, and mutate only caller-owned objects.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `npx vitest run src/sim/propagation/dp54.test.ts`

Expected: 2 tests pass.

- [ ] **Step 5: Commit the API and minimal propagator**

```powershell
git add src/sim/propagation/dp54.ts src/sim/propagation/dp54.test.ts
git commit -m "feat(sim): [T0015] add allocation-free DP54 propagator"
```

### Task 2: FSAL, adaptive rejection, and 4,000-step budget

**Files:**
- Modify: `src/sim/propagation/dp54.ts`
- Modify: `src/sim/propagation/dp54.test.ts`

**Interfaces:**
- Consumes: Task 1 `propagate`, workspace, tolerance, and result interfaces.
- Produces: verified FSAL derivative reuse, controller limits, and explicit budget/underflow status.

- [ ] **Step 1: Add failing controller and budget tests**

```ts
it('reuses the final derivative through FSAL after accepted steps', () => {
  let derivativeCalls = 0;
  const localTolerance = { ...tolerance, initialStepSec: 1 };
  const result = createDp54Result();
  propagate(new Float64Array(1), new Float64Array([0]), 0, 2, (_t, _state, derivative) => {
    derivativeCalls += 1;
    derivative[0] = 1;
  }, localTolerance, createDp54Workspace(1), result);

  expect(result.acceptedSteps).toBe(2);
  expect(derivativeCalls).toBe(13);
});

it('reports a partial horizon when the accepted-step budget is exhausted', () => {
  const localTolerance = { ...tolerance, initialStepSec: 1, maxAcceptedSteps: 2 };
  const output = new Float64Array(1);
  const result = createDp54Result();
  propagate(output, new Float64Array([0]), 0, 10_000, (_t, _state, derivative) => {
    derivative[0] = 0;
  }, localTolerance, createDp54Workspace(1), result);

  expect(result.acceptedSteps).toBe(2);
  expect(result.reachedTimeSec).toBe(6);
  expect(result.budgetExhausted).toBe(true);
  expect(result.reachedEnd).toBe(false);
  expect(result.nextStepSec).toBe(25);
});

it('rejects an oversized step and reduces it by the specified controller', () => {
  const output = new Float64Array(1);
  const result = createDp54Result();
  propagate(output, new Float64Array([1]), 0, 1, (_t, state, derivative) => {
    derivative[0] = 50 * state[0]!;
  }, { ...tolerance, initialStepSec: 1 }, createDp54Workspace(1), result);

  expect(result.rejectedSteps).toBeGreaterThan(0);
  expect(result.reachedEnd).toBe(true);
  expect(Math.abs(output[0]! - Math.exp(50)) / Math.exp(50)).toBeLessThan(1e-9);
});
```

- [ ] **Step 2: Run the three tests and verify RED**

Run: `npx vitest run src/sim/propagation/dp54.test.ts -t "FSAL|budget|oversized"`

Expected: at least FSAL call count and budget metadata fail before controller completion.

- [ ] **Step 3: Complete controller and FSAL behavior**

Use the published fifth-order weights `35/384, 0, 500/1113, 125/192, -2187/6784, 11/84, 0` and embedded fourth-order weights `5179/57600, 0, 7571/16695, 393/640, -92097/339200, 187/2100, 1/40`. Compute the maximum component error divided by `absolute[i] + relative * max(abs(current[i]), abs(candidate[i]))`. On acceptance, copy `k7` to `k1` for FSAL; on rejection retain `k1`. Apply the controller clamp `[0.2, 5]`, set factor `5` for zero error, and flag underflow when `timeSec + stepSec === timeSec`.

- [ ] **Step 4: Run focused and full DP54 tests**

Run: `npx vitest run src/sim/propagation/dp54.test.ts`

Expected: all DP54 unit tests pass.

- [ ] **Step 5: Commit controller behavior**

```powershell
git add src/sim/propagation/dp54.ts src/sim/propagation/dp54.test.ts
git commit -m "feat(sim): [T0015] enforce DP54 adaptive step budget"
```

### Task 3: Ship tolerance profile and two-body regression

**Files:**
- Modify: `src/sim/propagation/dp54.ts`
- Create: `tests/sim/propagation/dp54.test.ts`

**Interfaces:**
- Consumes: generic Task 1/2 DP54 API.
- Produces: `createShipDp54Tolerance(initialStepSec = 1, maxAcceptedSteps = 4_000)` for seven-component `(r,u,tau)` state and physics-spec §7.2 evidence.

- [ ] **Step 1: Add failing ship-profile and analytic two-body tests**

```ts
import { describe, expect, it } from 'vitest';
import {
  createDp54Result,
  createDp54Workspace,
  createShipDp54Tolerance,
  propagate,
} from '../../../src/sim/propagation/dp54.js';

const MU_KM3_S2 = 398_600.4418;

function twoBodyDerivative(_timeSec: number, state: Float64Array, output: Float64Array): void {
  const x = state[0]!;
  const y = state[1]!;
  const z = state[2]!;
  const inverseRadiusCubed = 1 / Math.pow(Math.hypot(x, y, z), 3);
  output[0] = state[3]!;
  output[1] = state[4]!;
  output[2] = state[5]!;
  output[3] = -MU_KM3_S2 * x * inverseRadiusCubed;
  output[4] = -MU_KM3_S2 * y * inverseRadiusCubed;
  output[5] = -MU_KM3_S2 * z * inverseRadiusCubed;
}

describe('dp54 — physics-spec.md §3.1 / §7.2', () => {
  it('provides the seven-component ship tolerance profile and 4000-step budget', () => {
    const tolerance = createShipDp54Tolerance();
    expect([...tolerance.absolute]).toEqual([1e-6, 1e-6, 1e-6, 1e-9, 1e-9, 1e-9, 1e-6]);
    expect(tolerance.relative).toBe(1e-9);
    expect(tolerance.maxAcceptedSteps).toBe(4_000);
  });
});
```

Add a helper that propagates circular `a=7_000 km, e=0` and eccentric `a=20_000 km, e=0.7` periapsis states for exactly ten analytic periods. Assert final position error `<1e-3 km`, relative specific-energy drift `<1e-9`, relative angular-momentum drift `<1e-9`, `reachedEnd === true`, and accepted steps `<=4_000`.

- [ ] **Step 2: Run the regression and verify RED**

Run: `npx vitest run tests/sim/propagation/dp54.test.ts`

Expected: FAIL because `createShipDp54Tolerance` and/or the ten-period accuracy are not implemented.

- [ ] **Step 3: Implement the ship profile and tune no physics tolerances**

```ts
export function createShipDp54Tolerance(
  initialStepSec = 1,
  maxAcceptedSteps = 4_000,
): Dp54Tolerance {
  return {
    absolute: new Float64Array([1e-6, 1e-6, 1e-6, 1e-9, 1e-9, 1e-9, 1e-6]),
    relative: 1e-9,
    initialStepSec,
    maxAcceptedSteps,
  };
}
```

If the analytic regression fails, correct the tableau, stage times, FSAL state, error normalization, or horizon clipping. Do not weaken the §7.2 assertions or change the specified tolerance profile.

- [ ] **Step 4: Run all tests and mandatory gates**

Run:

```powershell
npm run lint
npm run typecheck
npm test -- --run
npm run build
npm run format:check
npm run check:tasks
npm run check:budgets
git diff --check
```

Expected: all commands exit 0; two-body errors and drifts satisfy §7.2.

- [ ] **Step 5: Commit regression evidence**

```powershell
git add src/sim/propagation/dp54.ts tests/sim/propagation/dp54.test.ts
git commit -m "test(sim): [T0015] verify ten-period DP54 accuracy"
```

### Task 4: Delivery metadata and review handoff

**Files:**
- Modify: `tasks/T0015-dp54-integrator.yaml`

**Interfaces:**
- Consumes: all verified implementation and regression evidence.
- Produces: a review-ready task file and PR description mapped to both acceptance criteria.

- [ ] **Step 1: Update task status and handoff notes**

Set `status: REVIEW`. Record the exact accepted-step counts, position errors, energy drift, angular-momentum drift, budget test, test count, and gate results in `handoff_notes`.

- [ ] **Step 2: Validate and commit task metadata**

Run: `npm run check:tasks && npm run format:check && git diff --check`

Expected: all commands exit 0.

```powershell
git add tasks/T0015-dp54-integrator.yaml
git commit -m "chore(tasks): [T0015] ready for review"
```

- [ ] **Step 3: Rebase, push, open the PR, and request independent review**

Rebase on current `main`, push `task/T0015-dp54-integrator`, and open `[T0015] DP54 adaptive integrator`. The PR body must map §7.2 and the 4,000-step interface to measured evidence. A different agent must review before `DONE`.

## Self-Review

- Spec coverage: Tasks 1–3 cover the published DP54 tableau, embedded 5(4) error, FSAL, generic state, controller, ship tolerances, backward/zero horizons, 4,000-step budget, and both §7.2 ten-period regressions.
- Placeholder scan: no TBD/TODO placeholders or unspecified implementation steps remain.
- Type consistency: all tasks use `Float64Array`, `Dp54Derivative`, `Dp54Tolerance`, `Dp54Workspace`, `Dp54Result`, and the same `propagate` argument order.
