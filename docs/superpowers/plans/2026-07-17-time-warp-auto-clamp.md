# T0052 implementation plan

1. Add failing command tests for the >1000x throttle safety invariant and
   invalidation behavior.
2. Add failing `SimulationCore` tests for LEO clamp, deep-space sustain,
   canonical rollback, reason priority, and unchanged baseline ledger values.
3. Implement command-layer thrust lockout without allocations or interface
   expansion.
4. Add preallocated checkpoint/tolerance state to `SimulationCore` and perform
   ascending segmented propagation within one cumulative accepted-step budget.
5. Publish effective warp and reason from committed frame state; preserve hard
   failure rollback for underflow/non-finite/minimum-tier budget exhaustion.
6. Run focused tests, then formatting, lint, typecheck, the full Vitest suite,
   build, task schema, budgets, and simulation benchmark.
7. Mark T0052 REVIEW, open a PR with acceptance evidence, obtain independent
   review, address findings, wait for exact-head CI, and merge normally.

