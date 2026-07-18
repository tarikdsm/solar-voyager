# T0070 Trajectory Predictor Worker Design

## Goal

Predict the spacecraft's thrust-free future path without spending meaningful
main-thread frame time. The prediction must use the production float64 rails,
n-body gravity, relativistic state derivative, and DP54 tolerance profile;
return at most 2,000 renderable points; and report SOI transitions, closest
approach, and impact with time-to-impact.

## Chosen approach

Run one complete, stateless prediction job in a dedicated module worker. A
small game-layer client owns debounce and stale-result suppression, while a
pure simulation module performs the propagation. The worker imports that pure
module and the canonical body document, compiles setup data once, and transfers
the result buffers back without cloning their contents.

This is preferred over main-thread time slicing, which still competes with the
frame budget, and over streaming partial results, which adds ordering and
cancellation complexity without improving the task's acceptance criteria.

## Protocol and ownership

`predictorProtocol.ts` defines discriminated request, success, and error
messages. Each request carries a monotonically increasing integer ID, start
coordinate time, the seven-component relativistic ship state, osculating
period, optional user horizon, current dominant body, and optional target body.
The sender transfers ownership of the copied ship-state buffer.

Success returns two transferable float64 buffers:

- points use stride four: coordinate time, heliocentric x, y, z;
- events use stride six: event code, event time, primary body index, secondary
  body index, distance in kilometres, and time-to-impact in seconds.

SOI events use the primary and secondary body slots for previous and next
dominant bodies. Closest-approach and impact events use the primary body slot;
unused numeric fields are `NaN` or `-1` according to the protocol constants.
Error responses contain no transferred state and preserve the request ID.

## Propagation and sampling

The horizon is the greatest finite value among 90 days, twice a positive finite
osculating period, and a positive finite user extension. Invalid extensions are
rejected. Output count is clamped to 2,000 and includes both endpoints, with
uniform coordinate-time spacing.

The predictor creates the production ship DP54 tolerance and integrates one
mutable seven-component float64 state sequentially to every output time. Its
gravity derivative calls `evaluateRailsInto()` and
`evaluateNBodyAccelerationInto()` exactly as `SimulationCore` does, while its
proper-acceleration evaluator writes zero. No alternate force model is allowed.

The worker checks events at every accepted output point. Dominant-body changes
reuse `selectDominantBodyIndexWithHysteresis()`. Target closest approach is the
minimum sampled target-centre distance. Impact is the first outside-to-inside
crossing of each body's mean radius plus atmosphere top, with crossing time
linearly interpolated between the bracketing samples. Prediction stops at the
first impact so the final point and time-to-impact remain operationally useful.

## Debounce and stale work

The game-layer client is constructed with a worker-like port and a result
listener, making it browser-independent in unit tests. `invalidate()` marks the
prediction dirty and records the latest invalidation time. `update()` dispatches
only after 500 ms of quiet time and only when no equivalent request is already
pending. A newer invalidation may coexist with worker computation; its later
request ID makes the older response stale, and the client ignores it.

Thrust changes already surface through `SimulationCore`'s
`onTrajectoryInvalidated` callback. Warp elapsed time is represented by an
explicit invalidation from the future runtime consumer; T0071 can wire both
signals without changing `Commands` or `SimSnapshot` in this task.

The client copies the seven state components only when a debounced job is
actually posted. Its ordinary frame-loop `update()` path allocates nothing and
performs constant work, keeping main-thread impact below 0.5 ms.

## Physics documentation and compatibility

The event crossing and sampling rules are clarified in `physics-spec.md` and
recorded in a new ADR because that document changes. `SimSnapshot`, `Commands`,
and the `bodies.json` schema remain unchanged. Body collision radii are compiled
from existing `meanRadiusKm` and `surface.atmosphereTopKm` fields.

## Error handling

Protocol validators reject malformed IDs, state lengths, non-finite state or
times, invalid body indices, and non-positive user horizons. The pure predictor
also validates catalog-sized radius storage and output bounds. Worker failures
are returned as deterministic error messages, and one failed job does not make
the worker unusable.

## Verification

- A 30-day production-catalog regression compares the worker-core result with
  an independent main-thread propagation using the same canonical integrator;
  every sampled position must be within 1 km.
- Unit tests cover horizon selection, the 2,000-point cap, SOI transition
  encoding, target closest approach, impact interpolation, protocol validation,
  transferred buffers, debounce, stale-response suppression, and recovery.
- A microbenchmark measures the client update path and requires p99 below
  0.5 ms.
- Full lint, typecheck, Vitest, build, budgets, formatting, task schema, and
  independent review gates run before delivery.
