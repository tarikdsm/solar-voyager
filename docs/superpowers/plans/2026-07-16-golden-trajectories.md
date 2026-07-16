# T0016 Golden Trajectory Harness Implementation Plan

> Execute with test-driven development and verify each checkpoint before continuing.

**Goal:** Commit reproducible 30-day LEO, Earth-Mars coast, and Jupiter-flyby baselines plus a loud comparison harness and guarded regeneration command.

**Architecture:** Test-only scenario construction composes the production rails evaluator, n-body field, relativistic derivative, and DP54 propagator. A pure trajectory runner returns serializable histories; the normal regression reads committed JSON, while a separately guarded entrypoint writes it.

**Tech stack:** TypeScript, Vitest, Node.js, JSON.

---

### Task 1: Specify the regression contract

**Files:**
- Modify: `docs/physics-spec.md`
- Create: `docs/decisions/ADR-017-golden-trajectory-contract.md`

1. Add daily sampling, full-state component limits, production tolerance profile, and hard interval-budget failure to physics-spec section 7.6.
2. Record why component-wise absolute limits and segmented production calls were selected.
3. Run formatting checks for the new documents.

### Task 2: Build scenario construction and trajectory runner with TDD

**Files:**
- Create: `tests/golden/goldenTrajectoryHarness.test.ts`
- Create: `tests/golden/goldenTrajectoryHarness.ts`

1. Write failing tests for the three scenario identifiers, recorded parameters, deterministic initial states, 31 samples, endpoint time, finite values, and loud propagation-budget failure.
2. Run the focused test and confirm the expected missing-module failure.
3. Implement typed catalog loading, scenario state construction, coordinate-velocity-to-celerity conversion, full rails/n-body derivative, and segmented DP54 runner.
4. Run the focused test until green; keep production modules unchanged.

### Task 3: Add comparison diagnostics and guarded regeneration with TDD

**Files:**
- Create: `tests/golden/goldenComparison.test.ts`
- Create: `tests/golden/goldenComparison.ts`
- Create: `tests/golden/regenerateGoldenTrajectories.test.ts`
- Create: `tools/generateGoldenTrajectories.mjs`
- Modify: `package.json`
- Modify: `tests/README.md`

1. Write failing tests proving an out-of-tolerance component reports scenario/time/component/expected/actual/drift/limit.
2. Implement the component-wise comparator from physics-spec section 7.6.
3. Add a regeneration test that only writes with its environment capability.
4. Add a Node CLI guard that exits non-zero unless `--update-goldens` is supplied, then runs only the regeneration test.
5. Verify refusal without the flag and successful focused unit tests.

### Task 4: Generate and lock the baselines

**Files:**
- Create: `tests/golden/leo-30d.json`
- Create: `tests/golden/earth-mars-transfer-30d.json`
- Create: `tests/golden/jupiter-flyby-30d.json`
- Create: `tests/golden/goldenTrajectories.test.ts`

1. Run the guarded command with the explicit update flag.
2. Inspect generation parameters, state counts, finite values, integrator metadata, and closest flyby distance.
3. Commit only generated JSON files in a separate `golden:` commit.
4. Add the normal regression test that reads all three committed files and compares every sample.
5. Mutate a value temporarily to prove the regression fails loudly, restore it, and rerun green.

### Task 5: Verify and deliver

1. Run focused golden tests.
2. Run `npm test`, `npm run test:tools`, `npm run lint`, `npm run typecheck`, `npm run format:check`, `npm run build`, `npm run check:tasks`, and `npm run check:budgets` sequentially.
3. Request independent code review and address findings with re-verification.
4. Move T0016 to `REVIEW`, push the branch, open the PR, and hand it to an independent agent for `DONE`/merge.
