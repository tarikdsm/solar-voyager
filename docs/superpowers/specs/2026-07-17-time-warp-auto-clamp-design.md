# Time warp with automatic substep-budget clamp

## Goal

Make every `SimulationCore.step(wallDeltaSec)` honor the canonical warp ladder,
the 4,000 accepted-DP54-step frame budget, and the coast-only rule above 1000x,
while preserving double-buffer publication and zero allocations in the frame
loop.

## User-visible behavior

- `setWarp()` stores a canonical requested tier.
- A frame advances by `wallDeltaSec * effectiveWarp`.
- The effective tier is the highest requested-or-lower ladder tier whose full
  endpoint was reached inside the shared accepted-step budget.
- A budget fallback reports `INTEGRATION_BUDGET`.
- A sustainable tier above 1000x reports `THRUST_LOCKOUT` and coasts.
- Entering coast-only warp clears throttle. Throttle cannot be raised until the
  requested warp returns to 1000x or lower.
- A failed 1x propagation throws and publishes nothing.

## Integration model

The solver walks ascending candidate endpoints rather than trying the requested
endpoint and restarting from the frame origin. For requested 100000x it visits
1x, 5x, 10x, 50x, 100x, 1000x, 10000x, and 100000x. Each successful segment
copies its seven-component state into one preallocated checkpoint buffer. The
next segment receives `frameBudget - acceptedSoFar` and the previous segment's
suggested next step. If it fails, the checkpoint is copied into the inactive
ship buffer and becomes the frame result.

Segmenting at canonical endpoints slightly changes adaptive step boundaries but
does not change tolerances or equations. This is intentional: canonical
checkpoints are the only states that can truthfully pair with an effective warp
tier.

## State and interface semantics

No public field is added. ADR-024's reserved fields become operational:

- `requestedWarp`: current command intent.
- `effectiveWarp`: completed tier for this frame.
- `warpClampReason`: budget fallback first; otherwise high-warp thrust lockout;
  otherwise none.
- `throttle`, acceleration, force, and power: actual coast/thrust state after
  command safety enforcement.

The command controller owns the safety invariant `requestedWarp > 1000 =>
throttle === 0`. Crossing upward clears throttle and emits one trajectory
invalidation if thrust was active. Repeated or blocked commands do not emit
duplicates.

## Failure and rollback

- Partial state from an exhausted segment is never committed.
- Attitude is recomputed at the selected checkpoint before publication.
- Clock, private ship state, attitude, and snapshot index change only after a
  canonical endpoint succeeds.
- Step underflow or non-finite propagation remains a hard failure rather than a
  warp-budget clamp.

## Verification

- LEO at requested 1e7x clamps and exposes the reason.
- A far-field/coast case sustains 1e7x.
- All completed attempts together stay inside a deliberately small injected
  budget.
- High warp clears/blocks throttle and reports coast-only status.
- Warp changes preserve physical endpoint/proper-time behavior. Nonzero ledger
  invariance is verified after its owning implementation in T0053 lands.
- Failed 1x propagation retains the previously published frame.
- Performance tests confirm the same two snapshots and no frame allocations.
