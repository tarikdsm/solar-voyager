# ADR-027: Augmented integration state and fixed-capacity burn log

**Status:** accepted (2026-07-17)

## Context

The photon-drive ledger must be invariant to frame rate and time warp. Energy,
proper delta-v, and the inertial proper-delta-v vector therefore need the same
adaptive quadrature as ship motion. Updating totals once per rendered frame
would make curved attitude holds and relativistic proper time depend on frame
boundaries.

The public `SimSnapshot.shipState` contract is the seven-component `(r,u,tau)`
state. Extending that array would break render consumers and golden files. Burn
history must also avoid allocations in the frame loop.

## Decision

1. `SimulationCore` privately augments the seven physical components with five
   ledger quadratures: cumulative energy, scalar proper delta-v, and the three
   inertial components of proper delta-v. Public snapshots continue to expose
   exactly seven ship-state components.
2. The relativistic derivative writes all twelve rates in every DP54 stage.
   Ledger components do not feed back into motion. Failed propagation therefore
   rolls physical and ledger state back together.
3. Burn intervals are controlled by actual throttle transitions. A positive
   throttle opens or continues a burn; transition to zero closes it at the
   current committed simulation state. Changing positive throttle, attitude,
   target, or warp without coast does not split the interval.
4. Burn history is a setup-allocated ring of 256 mutable entry records. The
   public `BurnLogView` is a separate frozen facade with only getters and
   chronological lookup; the mutation capability remains private to
   `SimulationCore`. It creates no entry object during play.
5. Prograde, normal, and radial components use the dominant body's local frame
   at burn start. They are signed projections of the integrated inertial
   proper-delta-v vector. Scalar proper delta-v remains the non-negative path
   integral and can exceed the magnitude of the vector sum.
6. `kineticEnergyChangeJ` is current relativistic kinetic energy minus the
   constructor-time baseline. It may be negative during braking; photon-drive
   energy spent never decreases.

## Consequences

- Ledger totals are independent of render-frame partitioning and use exactly
  the accepted DP54 trajectory.
- T0052 can checkpoint and discard the augmented state atomically when warp
  fallback occurs.
- Snapshot consumers retain the ADR-024 seven-component ship state.
- Burn history is bounded. After 256 completed burns, the oldest entry is
  overwritten; chronological indexing remains stable for current contents.
- String formatting remains outside the frame loop; snapshots store numbers.
