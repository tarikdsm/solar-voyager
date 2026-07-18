# T0070 Final Review Fix Report

Date: 2026-07-18  
Branch: `task/T0070-predictor-worker`  
Task state: `REVIEW`

## Scope and root causes

The final review identified two Important findings and one Minor documentation
finding.

1. The pure predictor and setup modules imported packed-layout values from the
   worker protocol. The values were physically located in the adapter layer,
   and ESLint did not enforce the missing `sim -> workers` boundary.
2. The client set `pendingRequestId` and cleared `dirty` before `postMessage`
   returned, and it listened only for `message`. A synchronous send exception,
   worker `error`, or `messageerror` could therefore leave single-flight state
   pending forever.
3. The design still described impact observation between emitted samples even
   though ADR-030 and the implementation observe every accepted DP54 segment.

## TDD evidence

The transport regression tests were added before production changes. The RED
run was:

```text
npm test -- --run src/game/trajectoryPredictorClient.test.ts
Test Files  1 failed (1)
Tests       4 failed | 9 passed (13)
```

The failures matched the missing behavior:

- `postMessage` propagated `DataCloneError` instead of reporting a deterministic
  predictor error;
- `error` emitted no response and retained the pending job;
- `messageerror` emitted no response and retained the pending job;
- a stale job's transport failure did not release pending state for retry.

After the minimal client state-machine change, the focused client run passed all
14 tests. Coverage includes deterministic errors, safe monotonically increasing
request IDs across a failed send, 500 ms retry debounce, later success, stale
failure suppression, stable listener removal, ownership behavior, browser
`Worker` structural compatibility, and the existing clean-update p99 `< 0.5 ms`
gate.

## Implemented fixes

- Added `src/sim/analysis/trajectoryPredictionLayout.ts` as the pure owner of
  state dimension, point/event strides and offsets, event codes, the 2,000-point
  cap, and the 90-day base horizon.
- Updated predictor core, setup, and its colocated test to consume only the sim
  layout. `predictorProtocol.ts` imports and reexports the existing public names
  and retains worker message types, guards, horizon selection, and transfer
  helpers. There is no import cycle.
- Extended `import/no-restricted-paths` so `src/sim` cannot import
  `src/workers`; lint passes with the new gate.
- Made dispatch transactional: the safe request ID is reserved monotonically,
  but pending/clean state is committed only after `postMessage` returns.
  Synchronous failure retains dirty state, restarts the debounce, and emits
  `trajectory predictor dispatch failed` without exposing host details.
- Added stable `error` and `messageerror` listeners. A pending transport failure
  is released, marked dirty for retry after 500 ms, reported only when current,
  and ignored when no pending job exists. Dispose removes all listeners and
  terminates only an owned port.
- Updated the design to state that SOI and closest approach are evaluated at
  emitted points, while impact is tested on every accepted DP54 segment using
  body-relative segment/sphere intersection, matching ADR-030.

## Verification

| Gate | Result |
| --- | --- |
| Focused protocol/layout/predictor/client/runtime | 4 files, 33 passed |
| `npm run lint` | passed |
| `npm run typecheck` | passed |
| `npm run format:check` | passed |
| `npm test -- --run` | 94 passed + 1 skipped files; 585 passed + 3 skipped tests |
| `npm run test:tools` | 50 passed |
| `npm run build` | passed; existing >500 kB advisory, application chunk 914.76 kB |
| `npm run check:budgets` | passed; repo 139.26 MiB, assets 19.51 MiB, critical path 4.08 MiB |
| `npm run check:tasks` | 53 task files validated |
| `git diff --check` | passed |

An independent post-fix review of `21bf4a8..50015f9` inspected the layout
boundary, protocol compatibility, client recovery state machine, listener
lifecycle, and design alignment. It found no remaining Critical, Important, or
Minor defects in the requested scope.

## Commits and delivery

- `50015f9` — `fix(workers): [T0070] harden predictor recovery and layering`
- This report and the REVIEW handoff update are delivered in the following
  documentation commit.

No PR was created and the task remains in `REVIEW`, as required.
