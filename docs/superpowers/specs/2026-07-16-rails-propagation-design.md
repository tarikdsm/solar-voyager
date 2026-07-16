# T0013 Rails Propagation Design

## Goal and scope

Evaluate every catalog body as a deterministic heliocentric Cartesian state at
any finite number of TDB seconds since J2026. The implementation covers
physics-spec.md section 2: elliptic and hyperbolic mean-anomaly advance,
parent-relative moon states, and parent-chain accumulation in catalog order.

This task does not load JSON, integrate mutual gravity, or alter the catalog
schema. Callers validate/load `bodies.json` and pass the relevant typed fields
to this pure `src/sim/` module. T0014 will consume the resulting arrays for the
n-body gravity field.

## API and data layout

`src/sim/propagation/rails.ts` exposes four setup/evaluation operations:

- `compileRailsCatalog(bodies)` validates a root-first, parent-before-child
  input and compiles immutable hot-path data;
- `createRailsState(catalog)` allocates the caller-owned output arrays once;
- `createRailsWorkspace()` allocates the one reusable element/state/solver
  scratch set once;
- `evaluateRailsInto(state, catalog, timeSec, workspace)` fills or returns the
  cached state without allocating.

The compiled catalog and evaluated state use structure-of-arrays storage.
Positions and velocities are packed XYZ `Float64Array`s at `bodyIndex * 3`;
body GM and orbital fields are separate `Float64Array`s; parents are an
`Int32Array` with `-1` for the root. Body ids remain an ordered string array for
index lookup outside the frame loop. This layout gives T0014 contiguous data
and avoids fifty small state objects in every downstream subsystem.

The state records `timeSec`. Re-evaluating the same state at the same time is a
cache hit and returns immediately. A different output state or time performs a
complete O(n) pass.

## Evaluation algorithm

Compilation resolves every `parentId` to an earlier index. It rejects duplicate
ids, multiple/missing roots, missing orbital elements, non-finite inputs,
invalid elliptic/hyperbolic element branches, and parents that are absent or
not yet compiled. It precomputes each non-root body's parent GM and mean motion:

`n = sqrt((muParent + muBody) / |a|^3)`.

At evaluation time, one loop follows semantic catalog order:

1. The root is written as zero heliocentric position and velocity.
2. A single mutable element scratch copies the body's compiled constants and
   sets `M = M0 + n * timeSec`.
3. Existing `elementsToStateInto` evaluates the parent-relative state using its
   allocation-free Kepler scratch.
4. The already-evaluated parent's heliocentric position and velocity are added
   into the packed output.

Because parents precede children, Sun -> Jupiter -> Io and deeper chains need no
recursion, maps, or second pass. The hot path contains no array creation,
closures, object literals, or runtime lookup by id.

## Error handling and numerical contract

Catalog compilation and state/workspace construction are setup operations and
may throw descriptive errors. Evaluation rejects non-finite time and mismatched
array sizes before entering the loop. Valid evaluations use float64 throughout
and do not throw or allocate in the loop.

No new formula is introduced: mean-anomaly advance, parent-relative elements,
Kepler solving, and frame composition are already specified by
physics-spec.md section 2. Therefore this task does not change
`physics-spec.md` or require a new ADR.

## Verification

- Unit tests cover root origin, one-pass multi-level parent composition,
  cache reuse, negative/backward time, hyperbolic advance, and invalid catalog
  topology/data.
- Baked regression tests load `bodies.json` and `ephemerides-check.json`.
  Epoch positions for planets and Moon must be within 1 km. The +30 d and
  +365 d samples must satisfy the class bounds in physics-spec.md section 2.
- A dedicated Vitest benchmark compiles a deterministic synthetic 50-body
  catalog once, warms the evaluator, measures changing-time evaluations in
  batches, and requires median cost below 0.2 ms per full catalog evaluation.
- Full lint, typecheck, test, format, build, task-schema, and budget gates run
  before review.
