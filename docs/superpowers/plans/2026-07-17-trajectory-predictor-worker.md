# Trajectory Predictor Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development or superpowers:executing-plans to
> implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Deliver a production-model trajectory predictor in a dedicated worker
with transferable results, event detection, and a sub-0.5 ms main-thread
scheduler.

**Architecture:** A pure simulation predictor owns propagation and event
analysis. A worker adapter compiles canonical setup data and transfers packed
float64 outputs. A game-layer client owns 500 ms debounce and request ordering.

**Tech Stack:** TypeScript, Vitest, Vite module workers, float64 DP54 and n-body
physics.

## Global constraints

- Follow strict red-green-refactor for every production slice.
- Reuse `dp54.ts`, `nbodyForces.ts`, `rails.ts`, and the production tolerance;
  do not copy their formulas.
- Keep `src/sim` free of DOM and worker globals.
- Keep all physical values in km, km/s, s, and km3/s2.
- Transfer output buffers; do not use `SharedArrayBuffer`.
- Do not change `SimSnapshot`, `Commands`, or the `bodies.json` schema.

---

### Task 1: Protocol, horizon, and packed result contract

**Files:**
- Create: `src/workers/predictorProtocol.ts`
- Create: `src/workers/predictorProtocol.test.ts`

- [ ] Write failing tests for message validation, finite horizon selection,
      event/point strides, body indices, and transfer lists.
- [ ] Run `npx vitest run src/workers/predictorProtocol.test.ts` and confirm RED.
- [ ] Implement the minimal protocol constants, types, guards, horizon helper,
      and transfer-list helpers.
- [ ] Re-run the focused test and confirm GREEN.
- [ ] Commit the protocol slice.

### Task 2: Pure thrust-free predictor

**Files:**
- Create: `src/sim/analysis/trajectoryPredictor.ts`
- Create: `src/sim/analysis/trajectoryPredictor.test.ts`
- Modify: `docs/physics-spec.md`
- Create: `docs/decisions/ADR-XXX-trajectory-prediction-sampling.md`

- [ ] Write failing tests for endpoint sampling, the 2,000-point cap, canonical
      DP54/n-body propagation, SOI transitions, target closest approach, and
      first-impact interpolation.
- [ ] Run the focused tests and confirm RED because the predictor is absent.
- [ ] Implement setup validation, the zero-thrust production derivative,
      sequential DP54 sampling, and packed event writing.
- [ ] Clarify the exact sampling/crossing rules in the physics spec and record
      the decision in the next numbered ADR.
- [ ] Re-run predictor and affected physics tests and confirm GREEN.
- [ ] Commit the pure predictor slice.

### Task 3: Canonical module worker

**Files:**
- Create: `src/workers/predictor.worker.ts`
- Create: `src/workers/predictorWorkerRuntime.ts`
- Create: `src/workers/predictorWorkerRuntime.test.ts`

- [ ] Write failing runtime tests using a fake worker scope, including transfer
      ownership, deterministic error responses, and successful second jobs
      after a failed request.
- [ ] Run the focused runtime tests and confirm RED.
- [ ] Compile the canonical catalog and collision radii once, invoke the pure
      predictor per validated request, and post transferable success buffers.
- [ ] Keep the entry module limited to binding the runtime to `self`.
- [ ] Re-run focused worker tests and confirm GREEN.
- [ ] Commit the worker slice.

### Task 4: Allocation-free debounced client

**Files:**
- Create: `src/game/trajectoryPredictorClient.ts`
- Create: `src/game/trajectoryPredictorClient.test.ts`

- [ ] Write failing tests for the 500 ms quiet period, monotonic IDs, state copy
      at dispatch only, single-flight behavior, stale result suppression,
      explicit warp-elapsed invalidation, and disposal.
- [ ] Run the focused client test and confirm RED.
- [ ] Implement the worker-like injectable port and scheduler with no allocation
      on clean `update()` calls.
- [ ] Add a microbenchmark assertion that p99 client update cost is below
      0.5 ms on the project test environment.
- [ ] Re-run focused tests and confirm GREEN.
- [ ] Commit the client slice.

### Task 5: Thirty-day accuracy and build integration

**Files:**
- Create: `tests/workers/predictorAccuracy.test.ts`
- Modify only if necessary: `vite.config.ts`

- [ ] Write the 30-day test against an independent main-thread harness and
      confirm it fails before worker-core integration is complete.
- [ ] Compare all shared sample positions and require maximum error <= 1 km.
- [ ] Add a build-level assertion/import proving the module-worker entry bundles.
- [ ] Run the accuracy test, worker/client suite, typecheck, and production build.
- [ ] Commit the acceptance-test slice.

### Task 6: Verification, review, and delivery

**Files:**
- Modify: `tasks/T0070-trajectory-predictor-worker.yaml`

- [ ] Run `npm run lint`, `npm run typecheck`, `npm run format:check`,
      `npm test -- --run`, `npm run test:tools`, `npm run build`,
      `npm run check:budgets`, and `npm run check:tasks`.
- [ ] Record point count, 30-day maximum error, transferred byte count, and
      client p99 timing in task handoff notes.
- [ ] Move T0070 to REVIEW on the task branch and push it.
- [ ] Obtain independent review, resolve every finding with focused regression
      tests, and repeat all required gates.
- [ ] Mark DONE only after reviewer approval and green CI, then merge according
      to `docs/task-protocol.md`.
