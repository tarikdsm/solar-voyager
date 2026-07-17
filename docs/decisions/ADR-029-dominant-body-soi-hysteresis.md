# ADR-029: Hierarchical SOI hysteresis for dominant-body analysis

**Status:** accepted (2026-07-17)

## Context

The dominant body drives osculating elements, orbital HUD labels, and the
instant-feedback conic. A raw maximum of `mu / distance^2` can alternate between
two bodies on adjacent frames near an influence boundary. Physics-spec section
6 already requires a ten-percent SOI hysteresis band, but did not define how
that band interacts with nested parent/child systems or unrelated contenders.

The committed body catalog already supplies positive SOI radii for every
non-root body and parent-first relationships for the complete hierarchy. The
frame loop cannot allocate transition state or rebuild catalog structures.

## Decision

1. The compiled rails catalog stores SOI radii in a setup-time `Float64Array`;
   the root's null radius becomes positive infinity.
2. Osculating analysis retains the previous dominant-body index in its existing
   setup-allocated workspace. `SimSnapshot` continues to publish only the
   selected index and its elements.
3. Selection first computes the raw maximum-gravity challenger. With previous
   dominant `D` and challenger `C`, a descendant enters only inside `0.9` of its
   own SOI and with more than `1.1` times `D`'s gravity score.
4. A current child remains selected until it exits `1.1` of its own SOI. Its
   ancestor may then reclaim dominance only with the same 10% gravity lead.
5. Unrelated contenders switch only with a 10% gravity lead. With no valid
   previous owner, the raw maximum is selected immediately.
6. Parent/descendant classification walks the compiled parent-index array with
   indexed loops. Selection creates no objects, arrays, closures, or strings.

## Consequences

- Osculating and HUD ownership remains stable while the ship crosses an SOI
  boundary or numerical scores fluctuate around equality.
- Nested moon/planet transitions respect the smaller body's entry and exit
  radii instead of being masked by the ancestor's larger SOI.
- Automatic attitude holds retain their existing instantaneous
  maximum-gravity rule from physics-spec section 3.0.1; this ADR governs the
  analysis/display dominant body only.
- No `SimSnapshot`, `Commands`, or `bodies.json` schema change is required.
