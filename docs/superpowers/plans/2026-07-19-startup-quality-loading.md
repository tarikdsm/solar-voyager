# T0100 startup quality and loading — implementation plan

1. Add failing tests for the documented high/medium/low capability fixtures,
   boundary values, invalid inputs, bounded three-render probe, manual-lock
   precedence, and `PerfGovernor` initial-rung behavior. Implement the pure
   startup selector and the smallest governor extension.
2. Add failing model/DOM tests for monotonic milestone publication, exact
   first-playable state, frozen diagnostics, sanitized failure, and Retry. Add
   the static semantic loading shell and bootstrap adapter.
3. Add failing `createEpochWorld` and `BodyVisualSystem` tests proving milestone
   order, exact eager hero requests, zero tier-3 requests before ready, explicit
   lazy enablement after activation, and eager compile completion. Implement the
   progress port and lazy-loading gate.
4. Wire capability capture, manual bypass, timing probe, detected initial rung,
   progress, diagnostics, menu deferral, recovery, transfer accounting, and lazy
   activation through `main.ts`. Keep the existing governor/frame loop unchanged
   after startup.
5. Add `tools/tests/startupRegression.mjs`, a bounded `test:startup` script and CI
   step. Cover empty-cache metrics, critical request allowlist, program stability,
   all selector fixtures, manual bypass, compact accessible loading UI, injected
   critical-request failure/retry, and zero console/page errors on success.
6. Extend the deterministic Terser post-pass to copied standalone JavaScript
   assets only when gzip size improves, prove two identical production builds,
   and run bundle, critical-path, asset, heap, draw, smoke, visual-tier, governor,
   tutorial and startup gates without changing any ceiling.
7. Record local/CI startup evidence under `docs/bench/`, update architecture and
   task handoff notes, run the complete TypeScript/Python/browser suite, obtain an
   independent C/I/M review, require exact-head CI, transition REVIEW to DONE,
   and merge without deleting the branch/worktree.
