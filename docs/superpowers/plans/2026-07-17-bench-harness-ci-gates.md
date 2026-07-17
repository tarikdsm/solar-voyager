# T0092 Bench Harness and CI Performance Gates Implementation Plan

1. Add failing unit tests for percentile/stability math and heap, workload, and bundle validators, including injected allocation and draw-call failures.
2. Implement the pure performance-gate utilities and versioned golden schema until the focused tests pass.
3. Add a production-preview measurement harness with High quality lock, stable telemetry sampling, forced-GC heap windows, browser error capture, and negative fixtures.
4. Add the 300-sample, 180-virtual-second fixed-seed Earth/Moon/Jupiter benchmark, two-run stability comparison, JSON output, and npm scripts.
5. Capture current production golden counts and bundle ceilings, then prove the positive gate and both negative fixtures locally.
6. Run the benchmark twice on the same machine, verify less than 5% timing variance, and commit the report under `docs/bench/`.
7. Wire the 30-second performance gate into CI and run format, lint, typecheck, unit, build, browser regressions, budgets, and task schema checks.
8. Update T0092 to REVIEW, document every acceptance criterion in the PR, obtain independent review, and merge only after exact-head CI approval.
