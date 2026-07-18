# ADR-030: Bounded trajectory-prediction sampling and crossing events

**Status:** accepted (2026-07-18)

## Context

The trajectory worker must return a useful long-horizon polyline and navigation
events without monopolizing worker time or transferring an unbounded buffer.
Adaptive DP54 steps are implementation details and are unsuitable render
vertices: their count and timing vary with local dynamics. Impact reporting also
needs one deterministic rule when a body surface lies between adjacent output
times, including when both render-sample endpoints are outside.

The canonical body document already supplies `meanRadiusKm` and an optional
`surface.atmosphereTopKm`. The existing dominant-body selector owns the SOI
hysteresis policy. No new `SimSnapshot`, `Commands`, or `bodies.json` field is
needed.

## Decision

1. Production predictions emit 2,000 points. Internal verification may request
   fewer points, but every request is clamped to 2,000 and must contain at least
   the initial and horizon endpoints.
2. Output times are uniformly spaced in coordinate time. One mutable float64
   `(r, u, tau)` state is propagated sequentially between adjacent output times
   with the production DP54 tolerance, canonical rails and n-body field,
   relativistic derivative, and zero proper acceleration. `propagate()` is
   called with a one-accepted-step budget, its `nextStepSec` is carried into the
   next call, and calls repeat until the output time. The production 4,000-step
   budget remains the maximum for each output interval.
3. SOI selection runs at each emitted point with the existing hysteretic
   selector. Target closest approach is the earliest exact tie among minimum
   sampled target-centre distances.
4. Body collision radii are compiled once as `meanRadiusKm` plus atmosphere top,
   with a missing atmosphere top equal to zero. Radius storage must match the
   compiled catalog body count exactly.
5. Impact is inspected between every pair of accepted DP54 step endpoints. For
   each body, use relative endpoints `r0 = ship0 - body0` and
   `r1 = ship1 - body1`, then `d = r1 - r0`. When the step starts outside, solve
   `|r0 + f*d|^2 = R^2` and accept the smallest root `f` in `[0,1]`.
6. Accepted steps are already time ordered. Within one step, the smallest root
   wins; catalog order breaks an exact tie. The crossing coordinate time and
   ship position are linearly interpolated by `f`.
7. The crossing position replaces the pending output sample and becomes the
   final point. Both the accepted-step loop and output loop stop. Time-to-impact
   is crossing coordinate time minus prediction start time.

## Consequences

- Point buffers have a deterministic upper bound and always preserve both
  endpoints when no impact occurs.
- Render sampling stays independent of adaptive integrator internals while the
  physical propagation continues to reuse the production model verbatim.
- SOI, closest-approach, and impact records use the approved packed protocol
  offsets and body indices.
- An outside-to-inside-to-outside passage between render samples is detected
  when any accepted DP54 segment intersects the collision sphere. The quadratic
  test itself adds no force-model evaluations or hidden time sub-sampling; it
  reuses accepted step endpoints and performs one body-relative segment test per
  catalog body.
- Collision geometry is linear within each accepted DP54 segment. Accuracy is
  tied to the production integrator's accepted-step error control, while render
  density remains independently capped at 2,000 points.
- No `SimSnapshot`, `Commands`, or `bodies.json` schema change is required.

## Alternatives considered

- **Return every accepted DP54 step:** rejected because buffer size and render
  density would depend on adaptive-controller behavior.
- **Add hidden collision sub-sampling or dense output:** rejected because
  accepted DP54 endpoints already provide deterministic observation segments;
  extra force evaluations would change the approved performance contract.
- **Report the first inside sample as impact time:** rejected because linear
  bracketing provides a deterministic and more useful crossing estimate at no
  additional propagation cost.
