# Ship Thrust and Attitude Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement allocation-free ship attitude modes, relativistic proper-acceleration thrust, photon-drive power, and predictor invalidation for T0051.

**Architecture:** Focused pure modules own quaternion/attitude-frame math and thrust conversion. `SimulationCore` evaluates them through preallocated stage scratch, keeps private attitude alongside private ship state, and publishes existing ADR-024 snapshot fields only after successful propagation.

**Tech Stack:** TypeScript 6, Float64Array, Vitest 4, existing rails/n-body/DP54/relativity/SimulationCore.

### Task 1: Quaternion and attitude-frame primitives

**Files:** `src/sim/ship/attitude.ts`, `src/sim/ship/attitude.test.ts`

- [ ] Write failing tests for +X mapping, antiparallel direction, constant body-rate rotation, reference-body selection, every hold mode, and degeneracies.
- [ ] Implement caller-buffer quaternion normalization, multiplication, axis-angle evaluation, forward extraction, maximum-gravity reference selection, and hold-direction writing.
- [ ] Run focused tests, typecheck, lint, and commit.

### Task 2: Proper thrust and photon-drive outputs

**Files:** `src/sim/ship/thrust.ts`, `src/sim/ship/thrust.test.ts`, `docs/physics-spec.md`

- [ ] Add the ADR-025 conventions/equations to physics-spec section 3.
- [ ] Write failing tests for 1 g configuration, throttle scaling, vector force, watts, zero throttle, and `alpha/gamma³` at gamma 2.
- [ ] Implement allocation-free acceleration/force/power writers and configuration validation.
- [ ] Run focused tests and static gates; commit.

### Task 3: Command invalidation event

**Files:** `src/sim/simulationSnapshot.ts`, `src/sim/simulationSnapshot.test.ts`

- [ ] Write failing tests for changed throttle, active attitude/rate/target changes, identical commands, and inactive direction changes.
- [ ] Add an optional stable callback to command-controller setup and invoke it only when effective thrust intent changes.
- [ ] Run focused tests and static gates; commit.

### Task 4: SimulationCore integration

**Files:** `src/sim/simulation.ts`, `src/sim/simulation.test.ts`, `src/game/createNewGameSimulation.ts`

- [ ] Write failing tests for snapshot proper acceleration/force/power, automatic prograde tracking through an orbit, manual endpoint rotation, failed-step rollback, and callback plumbing.
- [ ] Add private attitude/config state and preallocated stage scratch; replace zero proper acceleration with the live evaluator.
- [ ] Publish existing attitude/thrust/power fields only after successful propagation.
- [ ] Run all focused/full simulation tests and commit.

### Task 5: Performance, full verification, and delivery

**Files:** `src/sim/simulation.performance.test.ts`, `tasks/T0051-ship-thrust-attitude.yaml`

- [ ] Extend identity/heap verification through active thrust and automatic hold.
- [ ] Run the full CI matrix and simulation benchmark.
- [ ] Move T0051 to REVIEW, push, open PR, obtain independent exact-head review, fix findings, rerun CI, mark DONE, and merge normally.
- [ ] Claim the next unblocked canonical task.
