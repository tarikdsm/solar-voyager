# Simulation Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the pure, allocation-free `SimulationCore`, its ADR-gated snapshot/command boundary, the 400 km LEO initializer, and barycentric derived state required by T0050.

**Architecture:** Setup code supplies a compiled rails catalog and initial ship state. The core owns one clock, DP54 propagation workspace, command state, and two complete snapshot buffers; each step writes the inactive buffer and publishes it only after successful zero-thrust propagation. Focused analysis and initialization modules keep formulas independently testable.

**Tech Stack:** TypeScript 6, Float64Array, Vitest 4, existing rails, n-body force, relativistic kinematics, and DP54 modules.

## Global Constraints

- `src/sim` remains pure TypeScript with no DOM, Three.js, render, UI, JSON, I/O, or runtime globals.
- All physics uses float64 and km / km/s / s / km³/s² / kg units.
- Every frame-loop output is preallocated; `step()` creates no arrays, objects, closures, strings, or dates.
- Formulas cite `docs/physics-spec.md` sections 3 or 6.
- Snapshot and command shapes match ADR-024.
- Propulsion, warp clamps, ledger integration, attitude control, osculating analysis, and warnings remain neutral placeholders for their scheduled tasks.

---

### Task 1: Barycenter writer

**Files:**
- Create: `src/sim/analysis/barycenter.ts`
- Create: `src/sim/analysis/barycenter.test.ts`

- [ ] Write a failing test for an asymmetric three-body catalog whose independently calculated GM-weighted position and velocity are nonzero.
- [ ] Run `npm test -- src/sim/analysis/barycenter.test.ts` and confirm the missing-module failure.
- [ ] Implement `evaluateBarycenterInto(positionOut, velocityOut, mu, positions, velocities)` with validated setup-compatible buffer sizes and compensated scalar sums.
- [ ] Add failure tests for mismatched buffers and non-positive total GM.
- [ ] Run the focused test, typecheck, and lint; commit the slice.

### Task 2: New-game 400 km LEO state

**Files:**
- Create: `src/sim/ship/initialState.ts`
- Create: `src/sim/ship/initialState.test.ts`

- [ ] Write a failing test using a deterministic Sun/Earth catalog and independently reconstruct the epoch Earth state, radial unit vector, prograde tangent, circular speed, and celerity.
- [ ] Assert the ship coordinate velocity contains Earth's complete velocity and its Earth-relative remainder has magnitude `sqrt(muEarth / (radiusEarth + 400))`.
- [ ] Run the focused test and confirm the missing export.
- [ ] Implement `createNewGameLeoState(catalog, earthIndex, earthRadiusKm, altitudeKm)` as setup-only allocation code with finite/domain validation and `tau = 0`.
- [ ] Run focused tests, typecheck, and lint; commit the slice.

### Task 3: Snapshot and command contract

**Files:**
- Create: `src/sim/simulationSnapshot.ts`
- Create: `src/sim/simulationSnapshot.test.ts`

- [ ] Write failing contract tests for body/ship buffer dimensions, identity attitude, neutral deferred fields, and command validation/state retention.
- [ ] Define documented `SimSnapshot`, `Commands`, `AttitudeMode`, clamp/warning codes, fixed osculating storage, and internal buffer/command factories.
- [ ] Use numeric `utcTimeMs`, numeric warning bits, `dominantBodyIndex = -1`, and `osculatingElements.valid = false` for allocation-free deferred state.
- [ ] Implement throttle `[0,1]`, finite rotation-rate, canonical warp, attitude-mode, and target validation without dynamic hot-path allocation.
- [ ] Run focused tests, typecheck, and lint; commit the slice.

### Task 4: Derived vectors and SimulationCore

**Files:**
- Create: `src/sim/analysis/snapshotDerived.ts`
- Create: `src/sim/analysis/snapshotDerived.test.ts`
- Create: `src/sim/simulation.ts`
- Create: `src/sim/simulation.test.ts`

- [ ] Write failing derived-state tests for `v = u/gamma`, CM-relative velocity, `p = gamma*m*v_rel`, and `L = r_rel × p`.
- [ ] Implement a caller-buffer writer and verify exact vector identities without allocation.
- [ ] Write failing `SimulationCore` tests using a one-body Earth catalog: initial snapshot, a render-shaped consumer, two-buffer identity alternation, prior-frame immutability, and invalid wall-delta rejection.
- [ ] Implement constructor setup, stable command facade, zero-thrust relativistic derivative, endpoint rails evaluation, DP54 propagation, snapshot fill, and publish-after-success swap.
- [ ] Add a ten-period circular two-body regression using the production ship tolerance profile and the physics-spec operational acceptance bounds.
- [ ] Add a forced budget-failure test proving the last valid snapshot is not replaced.
- [ ] Run all T0050 tests, typecheck, and lint; commit the slice.

### Task 5: Catalog integration and performance verification

**Files:**
- Modify: `src/game/createEpochState.ts`
- Create or modify: `src/game/createEpochState.test.ts`
- Create: `tools/bench/simulationCoreBench.mjs`
- Modify: `package.json`

- [ ] Write a failing game-layer test proving the committed body catalog can construct the new-game simulation inputs and first snapshot.
- [ ] Refactor setup to share compiled catalog/LEO initialization while preserving existing camera behavior.
- [ ] Add a benchmark that warms the core, checks snapshot identity alternation, measures step time, and rejects retained heap growth across a fixed frame sample.
- [ ] Run the benchmark and record the measured result in task handoff notes.
- [ ] Run focused game and simulation tests, typecheck, lint, and build; commit the integration slice.

### Task 6: Full verification and delivery

**Files:**
- Modify: `tasks/T0050-simulation-core.yaml`

- [ ] Run `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, `npm run check:tasks`, `npm run check:budgets`, and the simulation benchmark.
- [ ] Run `git diff --check`, inspect scope/stat, and confirm no render/UI imports under `src/sim`.
- [ ] Move T0050 to `REVIEW` with acceptance evidence, commit, push, and open the task PR.
- [ ] Obtain independent review from an agent other than the implementer; address findings with focused regressions and rerun every gate.
- [ ] Merge normally only after exact-head CI is green, then mark T0050 `DONE` on `main` according to `docs/task-protocol.md`.
- [ ] Select and claim the next unblocked canonical task.
