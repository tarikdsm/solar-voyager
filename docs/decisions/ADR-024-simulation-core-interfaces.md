# ADR-024: Simulation core interfaces and double-buffered snapshots

**Status:** accepted (2026-07-17)

## Context

`SimulationCore` is the physical single source of truth, while render and UI
must consume its state without mutating it. The frame loop also has a strict
zero-allocation requirement. `docs/architecture.md` requires interface changes
to `SimSnapshot` and `Commands` to be recorded in an ADR.

Several fields belong to systems scheduled after T0050. Omitting them would
force repeated breaking interface changes; implementing their behavior now
would cross task boundaries. UTC display dates, warning collections, nullable
analysis objects, and fresh snapshot objects would also allocate in the hot
path.

## Decision

1. `SimSnapshot` is a double-buffered, immutable-per-frame view. Each buffer
   owns all of its typed arrays and fixed nested records. `step()` writes the
   inactive buffer and publishes it only after successful propagation. A
   consumer may retain the published view through the next `step()` call, but
   not indefinitely.
2. Time is exposed as TDB seconds plus numeric UTC epoch milliseconds. UI code
   creates `Date` or strings only at display cadence. Warp exposes requested
   and effective factors plus a closed numeric clamp-reason code.
3. Body state uses packed `Float64Array` position and velocity vectors in
   catalog order. Ship state exposes `(r,u,tau)`, coordinate and CM-relative
   vectors, gamma, fraction of light speed, attitude, throttle, thrust, power,
   and baseline ledger totals. Barycenter and relativistic momentum/angular
   momentum follow `docs/physics-spec.md` section 6.
4. Deferred analysis uses fixed storage: dominant body index `-1`, osculating
   elements with `valid: false`, and a warning bit mask. Deferred propulsion
   and ledger values start at zero. Later tasks may populate these fields
   without changing their shape.
5. `Commands` contains `setThrottle`, `setAttitudeMode`, `rotate`, `setWarp`,
   and `setTarget`. T0050 validates and stores intent in preallocated mutable
   command state. Physics effects remain assigned to their existing tasks.
6. `SimulationCore` receives a compiled catalog and initial ship state. It does
   not import JSON, DOM, Three.js, render, or UI modules. The simulation layer
   therefore remains deterministic and pure apart from mutation of explicitly
   owned state.

## Consequences

- Render and UI gain a stable contract while later simulation features retain
  their planned ownership.
- No snapshot, typed array, warning array, `Date`, or string is created during
  `step()`.
- Snapshot immutability is temporal rather than permanent; consumers needing
  history must copy outside the frame loop or use a purpose-built ring buffer.
- A failed integration leaves the previously published snapshot valid.
- Changing either public interface after this ADR requires a new ADR.
