# Rails Accuracy Regression Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Calibrate and enforce position and velocity accuracy bounds for every J2026 rails body at +30 and +365 days.

**Architecture:** Keep the production propagator and baked data unchanged. Extend the existing Vitest regression with explicit fail-closed body classes and class/epoch vector limits, then make `docs/physics-spec.md` the source of the measured maxima, calibration rule, and resulting tolerances.

**Tech Stack:** TypeScript 5, Vitest 4, JSON catalog/check vectors, Markdown physics specification.

## Global Constraints

- Compare all 43 catalog bodies against `data/ephemerides-check.json` at +30 and +365 days.
- Calculate Euclidean 3D errors for position in km and velocity in km/s.
- Set each limit to the measured class maximum times 1.10, rounded upward to two significant digits.
- Unknown catalog ids and missing reference states must fail; no body may be skipped.
- Do not modify `src/sim/`, runtime interfaces, or baked JSON data.
- Tolerances must be stated in `docs/physics-spec.md` before the final assertions use them.

---

### Task 1: Publish the calibrated accuracy contract

**Files:**
- Create: `docs/decisions/ADR-020-calibrated-full-catalog-rails-accuracy.md`
- Modify: `docs/physics-spec.md` section 2

**Interfaces:**
- Consumes: J2026 rails and Horizons vectors already pinned by T0021.
- Produces: normative position/velocity limits consumed by the regression test.

- [ ] **Step 1: Record the calibration decision**

Create ADR-020 documenting why ADR-019's provisional position ceilings are being
superseded, why velocity is now covered, the four retained body classes, the
`ceil-to-two-significant-digits(1.10 * measured maximum)` rule, exact-Sun and
fail-closed behavior, consequences, and the rejected global/per-body/position-only
alternatives.

- [ ] **Step 2: Replace the provisional table with measured position values**

Use a `measured / limit` table with these exact values:

```markdown
| Body class | position @ +30 d (measured / limit) | position @ +365 d (measured / limit) |
|---|---:|---:|
| Planets and Moon (Luna) | 34,077.128 / 38,000 km | 1,159,878.882 / 1,300,000 km |
| Dwarfs, Mars moons, Charon | 65,375.338 / 72,000 km | 815,969.108 / 900,000 km |
| Giant-planet moons | 186,935.792 / 210,000 km | 644,966.151 / 710,000 km |
| Asteroids and comets | 3,428.256 / 3,800 km | 645,327.779 / 710,000 km |
```

- [ ] **Step 3: Add the measured velocity table**

```markdown
| Body class | velocity @ +30 d (measured / limit) | velocity @ +365 d (measured / limit) |
|---|---:|---:|
| Planets and Moon (Luna) | 0.0376412 / 0.042 km/s | 0.252232 / 0.28 km/s |
| Dwarfs, Mars moons, Charon | 0.950343 / 1.1 km/s | 1.902382 / 2.1 km/s |
| Giant-planet moons | 14.653602 / 17 km/s | 25.025758 / 28 km/s |
| Asteroids and comets | 0.00267517 / 0.0030 km/s | 0.0475048 / 0.053 km/s |
```

Immediately below the tables, state that limits are `ceil-to-two-significant-digits(1.10 * measured maximum)`, that the Sun remains exact, and that catalog growth must add a calibrated class before passing CI. Replace the ADR-019 provisional wording with a reference to this T0023 calibration while retaining ADR-019 as historical context.

- [ ] **Step 4: Validate and commit the contract**

Run:

```powershell
npm run format:check
git diff --check
```

Expected: both commands exit 0.

Commit:

```powershell
git add docs/decisions/ADR-020-calibrated-full-catalog-rails-accuracy.md docs/physics-spec.md
git commit -m "docs(physics): [T0023] calibrate rails accuracy bounds"
```

### Task 2: Add full position and velocity regression coverage

**Files:**
- Modify: `tests/sim/propagation/rails.test.ts`

**Interfaces:**
- Consumes: `RailsState.positionsKm`, `RailsState.velocitiesKmS`, catalog ids, and the section 2 limits.
- Produces: a fail-closed regression over every body at both check epochs.

- [ ] **Step 1: Write the failing velocity assertion**

Add this assertion beside the existing position assertion before defining either referenced velocity helper:

```ts
expect(
  velocityErrorKmS(state, bodyIndex, sample.states[bodyId] as CheckState),
  `${bodyId} velocity @ +${sample.offsetDays} d`,
).toBeLessThan(velocityLimitKmS(bodyId, sampleIndex));
```

Run:

```powershell
npm test -- tests/sim/propagation/rails.test.ts
```

Expected: FAIL because `velocityErrorKmS`/`velocityLimitKmS` are not defined, proving the new requirement is exercised.

- [ ] **Step 2: Add the velocity error helper**

Place beside `positionErrorKm`:

```ts
function velocityErrorKmS(state: RailsState, bodyIndex: number, expected: CheckState): number {
  const componentIndex = bodyIndex * 3;
  return Math.hypot(
    (state.velocitiesKmS[componentIndex] as number) - (expected.velocityKmS[0] as number),
    (state.velocitiesKmS[componentIndex + 1] as number) - (expected.velocityKmS[1] as number),
    (state.velocitiesKmS[componentIndex + 2] as number) - (expected.velocityKmS[2] as number),
  );
}
```

- [ ] **Step 3: Replace independent position limits with vector bounds**

Define:

```ts
interface AccuracyLimit {
  readonly positionKm: number;
  readonly velocityKmS: number;
}

type AccuracyClass = 'planet' | 'local' | 'giantMoon' | 'small';

const ACCURACY_LIMITS: Readonly<Record<AccuracyClass, readonly [AccuracyLimit, AccuracyLimit]>> = {
  planet: [
    { positionKm: 38_000, velocityKmS: 0.042 },
    { positionKm: 1_300_000, velocityKmS: 0.28 },
  ],
  local: [
    { positionKm: 72_000, velocityKmS: 1.1 },
    { positionKm: 900_000, velocityKmS: 2.1 },
  ],
  giantMoon: [
    { positionKm: 210_000, velocityKmS: 17 },
    { positionKm: 710_000, velocityKmS: 28 },
  ],
  small: [
    { positionKm: 3_800, velocityKmS: 0.003 },
    { positionKm: 710_000, velocityKmS: 0.053 },
  ],
};
```

Implement `accuracyClassForBody(bodyId)` using the four existing explicit id sets; return the matching class and throw `rails accuracy bound has not been calibrated for ${bodyId}` otherwise. Handle `sun` before class lookup with `{ positionKm: 0, velocityKmS: 0 }`. Replace `positionLimitKm` with `accuracyLimit(bodyId, sampleIndex): AccuracyLimit`, selecting tuple index `sampleIndex - 1` and throwing for any index other than 1 or 2.

- [ ] **Step 4: Assert both vector quantities for every body**

In the +30/+365 parameterized test, calculate one `AccuracyLimit` per body. For the Sun, use exact equality for both errors. For all other bodies, use strict `toBeLessThan` assertions with labels containing body id, quantity, and offset days:

```ts
const expected = sample.states[bodyId] as CheckState;
const limit = accuracyLimit(bodyId, sampleIndex);
const positionError = positionErrorKm(state, bodyIndex, expected);
const velocityError = velocityErrorKmS(state, bodyIndex, expected);

if (bodyId === 'sun') {
  expect(positionError, `${bodyId} position @ +${sample.offsetDays} d`).toBe(0);
  expect(velocityError, `${bodyId} velocity @ +${sample.offsetDays} d`).toBe(0);
} else {
  expect(positionError, `${bodyId} position @ +${sample.offsetDays} d`).toBeLessThan(
    limit.positionKm,
  );
  expect(velocityError, `${bodyId} velocity @ +${sample.offsetDays} d`).toBeLessThan(
    limit.velocityKmS,
  );
}
```

Update the fail-closed test to call `accuracyLimit('newbody', 1)`. Add an assertion that `samples.map(({ offsetDays }) => offsetDays)` equals `[0, 30, 365]`, preventing missing or reordered checks from silently changing tuple semantics.

- [ ] **Step 5: Run the focused suite and commit**

Run:

```powershell
npm test -- tests/sim/propagation/rails.test.ts
npm run typecheck
```

Expected: focused tests and typecheck pass.

Commit:

```powershell
git add tests/sim/propagation/rails.test.ts
git commit -m "test(sim): [T0023] enforce full rails vector accuracy"
```

### Task 3: Verify and deliver T0023

**Files:**
- Modify: `tasks/T0023-rails-regression.yaml`

**Interfaces:**
- Consumes: completed specification and regression suite.
- Produces: a REVIEW-ready task and acceptance evidence for the PR.

- [ ] **Step 1: Run all repository gates sequentially**

```powershell
npm run lint
npm run typecheck
npm test
npm run test:tools
npm run format:check
npm run build
npm run check:tasks
npm run check:budgets
git diff --check
```

Expected: every command exits 0; the build may retain the known bundle-size warning but no budget gate may fail.

- [ ] **Step 2: Promote the task to REVIEW**

Set `status: REVIEW` and write handoff notes containing the measured position/velocity maxima, the 10% two-significant-digit calibration rule, and the exact gate results.

Commit:

```powershell
git add tasks/T0023-rails-regression.yaml
git commit -m "chore(tasks): [T0023] move rails regression to review"
```

- [ ] **Step 3: Rebase, push, and open the PR**

```powershell
git fetch origin
git rebase origin/main
git push -u origin task/T0023-rails-regression
gh pr create --base main --head task/T0023-rails-regression --title "[T0023] Rails accuracy regression suite"
```

The PR body must list coverage of all 43 bodies at both epochs, the four measured/limit rows for both position and velocity, the fail-closed behavior, and every successful verification command.
