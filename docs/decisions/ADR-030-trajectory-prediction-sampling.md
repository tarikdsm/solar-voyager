# ADR-030: Bounded trajectory-prediction sampling and crossing events

**Status:** accepted (2026-07-18)

## Context

The trajectory worker must return a useful long-horizon polyline and navigation
events without monopolizing worker time or transferring an unbounded buffer.
Adaptive DP54 steps are implementation details and are unsuitable render
vertices: their count and timing vary with local dynamics. Impact reporting also
needs one deterministic rule when a body surface lies between adjacent output
times.

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
   relativistic derivative, and zero proper acceleration.
3. SOI selection runs at each emitted point with the existing hysteretic
   selector. Target closest approach is the earliest exact tie among minimum
   sampled target-centre distances.
4. Body collision radii are compiled once as `meanRadiusKm` plus atmosphere top,
   with a missing atmosphere top equal to zero. Radius storage must match the
   compiled catalog body count exactly.
5. Impact is the first adjacent-sample bracket with previous clearance
   `distance - collisionRadius > 0` and current clearance `<= 0`. Crossing time
   is linearly interpolated between those clearances. The earliest crossing in
   the interval wins; catalog order breaks an exact tie.
6. The inside sample is replaced by a linearly interpolated crossing position,
   which becomes the final point. No later samples or events are produced.
   Time-to-impact is the crossing coordinate time minus prediction start time.

## Consequences

- Point buffers have a deterministic upper bound and always preserve both
  endpoints when no impact occurs.
- Render sampling stays independent of adaptive integrator internals while the
  physical propagation continues to reuse the production model verbatim.
- SOI, closest-approach, and impact records use the approved packed protocol
  offsets and body indices.
- A complete outside-to-inside-to-outside passage between two adjacent samples
  can be missed because neither endpoint is inside. This known limitation is a
  direct consequence of the 2,000-point bounded sampling contract; this ADR does
  not authorize hidden sub-sampling or an alternate integrator.
- No `SimSnapshot`, `Commands`, or `bodies.json` schema change is required.

## Alternatives considered

- **Return every accepted DP54 step:** rejected because buffer size and render
  density would depend on adaptive-controller behavior.
- **Add hidden collision sub-sampling or dense output:** deferred because it
  changes the approved computation and performance contract and requires a
  separately specified accuracy/budget decision.
- **Report the first inside sample as impact time:** rejected because linear
  bracketing provides a deterministic and more useful crossing estimate at no
  additional propagation cost.
