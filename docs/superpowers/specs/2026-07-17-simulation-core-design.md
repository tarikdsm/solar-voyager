# T0050 Simulation Core Design

## Scope

Implement the pure TypeScript owner of simulation time, analytic body rails,
the relativistic ship state, baseline ledger values, and the immutable-per-frame
snapshot contract described by `docs/architecture.md`. The core advances a
zero-thrust ship through the existing production DP54 integrator and exposes
the player-intent command boundary without implementing the propulsion, warp,
attitude, targeting, or analysis systems assigned to later tasks.

## Public boundary

`src/sim/simulationSnapshot.ts` defines the ADR-gated interfaces:

- `SimSnapshot`, a stable object whose scalar fields and preallocated typed
  arrays contain one completed frame;
- `Commands`, the only route for player intent into the simulation;
- closed string unions for attitude mode and warnings, plus the osculating
  element view that later analysis tasks will populate.

Snapshots use two complete storage sets. `SimulationCore.step()` writes only to
the inactive set and swaps it into publication after propagation succeeds. The
previous object and every array reachable from it remain unchanged until a
later step reuses that buffer. Consumers must retain a snapshot for no longer
than one following simulation step.

UTC display time is represented by the numeric `utcTimeMs` mapping already
defined in `src/core/time.ts`, rather than a `Date`, so the frame loop does not
allocate. Warnings use a numeric bit mask. Osculating elements use a fixed
object with a `valid` flag, avoiding nullable allocations or per-frame object
replacement.

## Core ownership and data flow

`SimulationCore` is constructed at setup time from a compiled rails catalog,
an initial seven-component ship state, and immutable ship configuration. It
allocates:

1. one mutable simulation clock;
2. two rails states embedded in the two snapshots;
3. two ship-state buffers;
4. one DP54 workspace and result record;
5. fixed gravity and derived-vector scratch arrays;
6. one mutable command-state object exposed through a stable `Commands`
   facade.

At construction, both snapshot buffers are initialized at the same epoch. Per
frame, `step(wallDeltaSec)` validates a finite, non-negative wall delta, computes
the requested endpoint at the currently effective warp, evaluates rails for
each DP54 derivative time, applies the existing n-body gravity field, propagates
with zero proper acceleration, evaluates rails at the exact endpoint, derives
the snapshot, and publishes it. A propagation failure throws before the buffer
swap, preserving the last valid published snapshot.

T0050 starts with warp fixed at `1`, zero throttle/thrust/power/ledger totals,
identity attitude, no target, no warnings, and invalid osculating elements.
Commands validate and retain requested player intent in preallocated state;
later tasks connect those values to dynamics and derived analysis. The snapshot
reports both requested and effective warp so T0052 can add clamps without an
interface change.

## Barycenter and derived state

`src/sim/analysis/barycenter.ts` implements `docs/physics-spec.md` section 6.
It weights positions and velocities by GM (`mu`), because the common factor
`1/G` cancels from the center-of-mass ratio:

```text
r_cm = sum(mu_i * r_i) / sum(mu_i)
v_cm = sum(mu_i * v_i) / sum(mu_i)
```

The snapshot also stores coordinate velocity `v = u/gamma`, CM-relative ship
velocity, proper acceleration, relativistic momentum
`p = gamma*m*(v-v_cm)`, and angular momentum
`L = (r-r_cm) x p`. All functions write into caller-owned arrays and allocate
nothing.

## New-game LEO state

`src/sim/ship/initialState.ts` creates the setup-time 400 km prograde Earth
orbit used by the golden trajectory harness. It evaluates Earth at the epoch,
uses the heliocentric Earth direction as the radial direction, chooses the
prograde tangent consistent with Earth's velocity, and adds the circular
Earth-relative velocity `sqrt(mu_earth/r)` to Earth's complete rails velocity.
Coordinate velocity is converted to celerity before writing `(r,u,tau)`.

This addition is essential: initializing only the local circular speed would
erase Earth's approximately 30 km/s motion relative to the solar-system
barycenter. The acceptance test independently reconstructs both the inherited
Earth component and the local circular component.

## API shape

The core exposes:

- `snapshot`: the latest published `SimSnapshot`;
- `commands`: one stable `Commands` object;
- `step(wallDeltaSec): SimSnapshot`.

The constructor accepts prepared simulation inputs rather than importing
`data/bodies.json`. Catalog compilation and JSON access remain setup concerns
in the `game` layer, preserving `sim` purity and enabling small deterministic
test catalogs.

## Verification

Vitest coverage will prove:

1. barycenter position and velocity match an independent mass-weighted sum;
2. the new-game state inherits Earth's barycentric velocity and has the
   expected 400 km circular Earth-relative component;
3. a render-shaped stub consumes a snapshot without any `render` or `ui`
   import in `src/sim`;
4. snapshots alternate between exactly two object/array identities and the
   prior frame remains unchanged through the next step;
5. zero-thrust propagation preserves a circular two-body orbit within the
   production tolerance contract;
6. invalid wall deltas and propagation failure cannot publish partial state;
7. the simulation frame path has zero retained heap growth and no per-frame
   state allocations by identity inspection.

Full repository lint, typecheck, test, build, task-schema, and asset-budget
gates remain mandatory before review.

## Non-goals

T0050 does not implement photon-drive force or ledger integration (T0051 and
T0053), warp selection/clamping (T0052), attitude dynamics (T0054-T0056),
dominant-body and osculating analysis (T0057), warnings/prediction (T0058), or
HUD/render integration. Their storage contracts are initialized here only when
required by `SimSnapshot`.
