# T0053 implementation plan

1. Add failing unit tests for photon-drive derivative rates, energy/Wh and
   power/W formatters, and the fixed-capacity burn-log lifecycle.
2. Add failing SimulationCore regressions for analytic Hohmann cost, continuous
   plane-change pricing, nonzero 1x/100x invariance, and rollback.
3. Implement ledger indices and optional augmented rates in the relativistic
   derivative; keep the public seven-component state unchanged.
4. Expand SimulationCore's private state/workspace/tolerance once at setup and
   publish cumulative totals plus kinetic-energy change.
5. Add throttle-transition observation, dominant-body start basis, and the
   preallocated 256-entry burn log.
6. Run focused tests and benchmark, then all repository gates and browser
   playtest required for simulation changes.
7. Deliver via PR, obtain independent exact-head review, resolve findings, and
   merge normally. Then resume T0052 and add the real segmented-warp ledger
   regression requested by its reviewer.

