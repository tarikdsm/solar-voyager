# Relativistic Kinematics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a pure, allocation-free relativistic kinematics module for the seven-component ship state and verify every T0017 acceptance criterion.

**Architecture:** `src/sim/ship/relativity.ts` exposes robust scalar and buffer-writing helpers plus a DP54-compatible derivative factory. Callers supply gravity and proper-acceleration evaluators; the factory owns two reusable acceleration buffers so each derivative evaluation performs no allocations.

**Tech Stack:** TypeScript 6, Float64Array, Vitest 4, existing allocation-free DP54 integrator.

## Global Constraints

- `src/sim/` stays pure TypeScript with no Three.js, DOM, globals, or side effects.
- All state uses float64 with km, km/s, s, km/s^2, kg, kg km/s, and joules.
- Every formula cites `docs/physics-spec.md` sections 3, 6, 7.8, 7.9, or 7.11.
- The derivative evaluation path allocates zero objects or arrays.
- `SimSnapshot`, `Commands`, `bodies.json`, and physics formulas remain unchanged.
- Tolerances come directly from `docs/physics-spec.md`.

---

### Task 1: Relativistic conversion and energy helpers

**Files:**
- Create: `src/sim/ship/relativity.ts`
- Create: `tests/sim/ship/relativity.test.ts`

**Interfaces:**
- Consumes: `SPEED_OF_LIGHT_KM_S` from `src/core/constants.ts`.
- Produces: `RELATIVISTIC_STATE_DIMENSION`, `STATE_RX`, `STATE_RY`, `STATE_RZ`, `STATE_UX`, `STATE_UY`, `STATE_UZ`, `STATE_TAU`, `lorentzFactorFromCelerity(ux, uy, uz)`, `coordinateVelocityInto(output, ux, uy, uz)`, `speedFractionOfLightFromCelerity(ux, uy, uz)`, `relativisticMomentumInto(output, ux, uy, uz, massKg)`, and `relativisticKineticEnergyJ(ux, uy, uz, massKg)`.

- [ ] **Step 1: Write failing helper tests**

Add tests using `u = sqrt(3)c`, where `gamma = 2`, `v/c = sqrt(3)/2`, `p = m*u`, and `E_kin = m*c^2`:

```ts
const celerityX = Math.sqrt(3) * SPEED_OF_LIGHT_KM_S;
expect(lorentzFactorFromCelerity(celerityX, 0, 0)).toBeCloseTo(2, 14);
expect(speedFractionOfLightFromCelerity(celerityX, 0, 0)).toBeCloseTo(Math.sqrt(3) / 2, 14);

const velocity = new Float64Array(3);
coordinateVelocityInto(velocity, celerityX, 0, 0);
expect((velocity[0] as number) / SPEED_OF_LIGHT_KM_S).toBeCloseTo(Math.sqrt(3) / 2, 14);

const momentum = new Float64Array(3);
relativisticMomentumInto(momentum, celerityX, 0, 0, 5);
expect(momentum[0]).toBe(5 * celerityX);

const cMetersSec = SPEED_OF_LIGHT_KM_S * 1_000;
expect(relativisticKineticEnergyJ(celerityX, 0, 0, 5) / (5 * cMetersSec ** 2)).toBeCloseTo(1, 14);
```

- [ ] **Step 2: Run the helper tests and confirm the missing-module failure**

Run: `npm test -- tests/sim/ship/relativity.test.ts`

Expected: FAIL because `src/sim/ship/relativity.ts` does not exist.

- [ ] **Step 3: Implement robust scalar and buffer-writing helpers**

Use dimensionless celerity components to avoid overflow in the Lorentz factor:

```ts
export function lorentzFactorFromCelerity(ux: number, uy: number, uz: number): number {
  return Math.hypot(
    1,
    ux / SPEED_OF_LIGHT_KM_S,
    uy / SPEED_OF_LIGHT_KM_S,
    uz / SPEED_OF_LIGHT_KM_S,
  );
}

export function coordinateVelocityInto(
  output: Float64Array,
  ux: number,
  uy: number,
  uz: number,
): Float64Array {
  const inverseGamma = 1 / lorentzFactorFromCelerity(ux, uy, uz);
  output[0] = ux * inverseGamma;
  output[1] = uy * inverseGamma;
  output[2] = uz * inverseGamma;
  return output;
}
```

Implement speed fraction as `w / hypot(1, w)`, momentum as `m*u`, and kinetic energy with the cancellation-resistant identity `gamma - 1 = w * (w / (gamma + 1))`.

- [ ] **Step 4: Run focused tests and static checks**

Run: `npm test -- tests/sim/ship/relativity.test.ts && npm run typecheck && npm run lint`

Expected: helper tests PASS; typecheck and lint exit 0.

- [ ] **Step 5: Commit the helper slice**

```bash
git add src/sim/ship/relativity.ts tests/sim/ship/relativity.test.ts
git commit -m "feat(sim): [T0017] add relativistic state helpers"
```

### Task 2: Allocation-free ship derivative

**Files:**
- Modify: `src/sim/ship/relativity.ts`
- Modify: `tests/sim/ship/relativity.test.ts`

**Interfaces:**
- Consumes: seven-component state indices and `Dp54Derivative` from Task 1 and `src/sim/propagation/dp54.ts`.
- Produces: `RelativisticAccelerationEvaluator` and `createRelativisticDerivative(gravity, properAcceleration): Dp54Derivative`.

- [ ] **Step 1: Write a failing derivative composition test**

Use fixed gravity `(1, 2, 3)` and thrust `(4, 5, 6)`, then assert `dr/dt = u/gamma`, `du/dt = (5, 7, 9)`, and `dtau/dt = 1/gamma`. Capture the output buffers received by both callbacks and call the derivative twice to assert the same callback buffer identities are reused.

- [ ] **Step 2: Run the focused test and confirm the missing-export failure**

Run: `npm test -- tests/sim/ship/relativity.test.ts`

Expected: FAIL because `createRelativisticDerivative` is not exported.

- [ ] **Step 3: Implement the derivative factory**

```ts
export type RelativisticAccelerationEvaluator = (
  timeSec: number,
  state: Float64Array,
  outputAcceleration: Float64Array,
) => void;

export function createRelativisticDerivative(
  gravity: RelativisticAccelerationEvaluator,
  properAcceleration: RelativisticAccelerationEvaluator,
): Dp54Derivative {
  const gravityOutput = new Float64Array(3);
  const properAccelerationOutput = new Float64Array(3);

  return (timeSec, state, outputDerivative): void => {
    const ux = state[STATE_UX] as number;
    const uy = state[STATE_UY] as number;
    const uz = state[STATE_UZ] as number;
    const inverseGamma = 1 / lorentzFactorFromCelerity(ux, uy, uz);

    gravity(timeSec, state, gravityOutput);
    properAcceleration(timeSec, state, properAccelerationOutput);

    outputDerivative[STATE_RX] = ux * inverseGamma;
    outputDerivative[STATE_RY] = uy * inverseGamma;
    outputDerivative[STATE_RZ] = uz * inverseGamma;
    outputDerivative[STATE_UX] = (gravityOutput[0] as number) + (properAccelerationOutput[0] as number);
    outputDerivative[STATE_UY] = (gravityOutput[1] as number) + (properAccelerationOutput[1] as number);
    outputDerivative[STATE_UZ] = (gravityOutput[2] as number) + (properAccelerationOutput[2] as number);
    outputDerivative[STATE_TAU] = inverseGamma;
  };
}
```

- [ ] **Step 4: Run focused tests and static checks**

Run: `npm test -- tests/sim/ship/relativity.test.ts && npm run typecheck && npm run lint`

Expected: derivative composition and helper tests PASS; typecheck and lint exit 0.

- [ ] **Step 5: Commit the derivative slice**

```bash
git add src/sim/ship/relativity.ts tests/sim/ship/relativity.test.ts
git commit -m "feat(sim): [T0017] add relativistic ship derivative"
```

### Task 3: Analytic and Newtonian-limit propagation regressions

**Files:**
- Modify: `tests/sim/ship/relativity.test.ts`

**Interfaces:**
- Consumes: `createRelativisticDerivative`, all state indices, and DP54's `propagate`, `createDp54Workspace`, `createDp54Result`, and `createShipDp54Tolerance`.
- Produces: executable evidence for physics-spec sections 7.8, 7.9, and 7.11.

- [ ] **Step 1: Add the constant-proper-acceleration regression**

Integrate from rest with `alpha = 0.01 km/s^2` until
`t = c*sqrt(10^2 - 1)/alpha`. Assert DP54 reaches the endpoint, the numerical
velocity and `tau` match
`v = alpha*t/sqrt(1 + (alpha*t/c)^2)` and
`tau = (c/alpha)*asinh(alpha*t/c)` to relative error below `1e-9`, computed
gamma is 10 to the same tolerance, and speed is strictly below `c`.

- [ ] **Step 2: Run the analytic regression**

Run: `npm test -- tests/sim/ship/relativity.test.ts -t "hyperbolic motion"`

Expected: PASS within the 4,000 accepted-step budget.

- [ ] **Step 3: Add the ten-orbit Newtonian-limit regression**

Use Earth `mu = 398600.4418 km^3/s^2`, radius `6778.137 km`, and circular
speed `sqrt(mu/r)`. Propagate one six-component Newtonian state and one
seven-component relativistic state for ten analytic periods using identical
gravity. Assert both reach the endpoint and relative final-position separation
is below `1e-9`.

- [ ] **Step 4: Run the Newtonian-limit regression**

Run: `npm test -- tests/sim/ship/relativity.test.ts -t "Newtonian limit"`

Expected: PASS with relative separation below `1e-9`.

- [ ] **Step 5: Add time-dilation and high-celerity stress regressions**

For gamma 2, initialize `u = sqrt(3)c`, coast for `365.25*86400 s`, and assert
`tau = t/2` within `1e-9` relative error. Separately integrate constant proper
acceleration to gamma 1000 and assert every sampled/final coordinate speed is
finite and strictly below `c`.

- [ ] **Step 6: Run all T0017 tests and commit regressions**

Run: `npm test -- tests/sim/ship/relativity.test.ts`

Expected: all T0017 tests PASS.

```bash
git add tests/sim/ship/relativity.test.ts
git commit -m "test(sim): [T0017] verify relativistic propagation"
```

### Task 4: Full verification and task handoff

**Files:**
- Modify: `tasks/T0017-relativistic-kinematics.yaml`

**Interfaces:**
- Consumes: completed T0017 module and regression suite.
- Produces: a `REVIEW` task state and PR-ready acceptance evidence.

- [ ] **Step 1: Run every repository gate**

Run:

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run check:tasks
npm run check:budgets
```

Expected: every command exits 0.

- [ ] **Step 2: Review the diff and task scope**

Run: `git diff main...HEAD --check && git diff --stat main...HEAD && git status --short`

Expected: no whitespace errors, only the T0017 design/plan/module/tests/task file are in scope, and the worktree is clean before the status edit.

- [ ] **Step 3: Move T0017 to review**

Change only `status: IN_PROGRESS` to `status: REVIEW`, and set `handoff_notes`
to summarize the helper API, analytic tests, commands run, and numeric results.

- [ ] **Step 4: Commit and publish the review branch**

```bash
git add tasks/T0017-relativistic-kinematics.yaml
git commit -m "chore(tasks): [T0017] move relativistic kinematics to review"
git push -u origin task/T0017-relativistic-kinematics
```

- [ ] **Step 5: Open the pull request**

Create a PR titled `[T0017] Relativistic kinematics module` whose description
maps each acceptance criterion to the exact test and measured result. Do not
merge it because the task protocol requires a different reviewer.
