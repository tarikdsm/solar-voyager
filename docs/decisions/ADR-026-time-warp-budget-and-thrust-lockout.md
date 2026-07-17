# ADR-026: Time-warp budget clamp and thrust lockout

**Status:** accepted (2026-07-17)

## Context

`SimulationCore.step()` must advance the ship at one of the canonical warp
tiers without exceeding the per-frame budget of 4,000 accepted DP54 steps.
The requested tier may be sustainable in deep space but not near a gravity
well. The public snapshot already reserves requested/effective warp and a
closed clamp-reason code, while the command interface already accepts warp and
throttle intent.

A failed high-tier attempt cannot be published: it may stop between canonical
tiers and it has overwritten its output buffer. Retrying every tier from the
frame start would also spend more than the stated per-frame budget.

## Decision

1. A frame evaluates canonical tiers in ascending order up to the requested
   tier. Each completed tier is a valid checkpoint. The next segment starts at
   that checkpoint and receives only the remaining portion of the single
   4,000-accepted-step frame budget.
2. Checkpoints use one setup-time `Float64Array`. If a segment exhausts the
   remaining budget, the highest completed checkpoint is published. No
   partial, noncanonical horizon is exposed. The DP54 controller's suggested
   next step is carried between segments.
3. If even 1x cannot complete, there is no valid lower tier. The step fails and
   the previously published snapshot remains authoritative.
4. `requestedWarp` remains player intent. `effectiveWarp` is the highest tier
   completed in the current frame. `warpClampReason` is
   `INTEGRATION_BUDGET` when those values differ.
5. Warp above 1000x is a coast-only safety mode. Entering it clears any active
   throttle command; positive throttle commands made while it is active are
   forced to zero. Lowering warp does not restore old throttle intent. When no
   integration-budget clamp takes precedence, the snapshot reports
   `THRUST_LOCKOUT` at tiers above 1000x so the HUD can explain the coast mode.
6. The frame loop remains allocation-free. Tolerance views, rollback state,
   DP54 workspace, results, snapshots, and ship buffers are all allocated at
   construction.

## Consequences

- Accuracy is never silently relaxed to satisfy performance.
- Deep-space cruise can sustain the requested high tier, while LEO falls back
  to the best canonical tier actually completed within the budget.
- Total accepted work, including a failed final segment, never exceeds the
  configured per-frame budget.
- A high-warp transition can invalidate an active thrust trajectory because it
  clears throttle. Returning to physics warp requires an explicit new throttle
  command.
- Future ledger integration can use the same accepted trajectory segments; a
  discarded partial segment must not commit ledger state.

