# ADR-018: Select Kepler branch from orbital elements, not body kind

**Status:** accepted (2026-07-16)

## Context

Physics-spec §2 labeled the hyperbolic Kepler equation as “Hyperbolic (comets).” That shorthand is incorrect for the v1 catalog: the pinned J2026 Horizons records for 1P/Halley and 67P/Churyumov–Gerasimenko have `a > 0` with eccentricities approximately `0.968` and `0.650`, so both are bound elliptic objects. Conversely, an asteroid or interstellar object can be hyperbolic without being classified as a comet.

Horizons comet designations also resolve to multiple apparition records. A bake that asks for `1P` or `67P` by designation is ambiguous and can change selection as upstream solutions evolve.

## Decision

- Select the elliptic or hyperbolic solver solely from the schema-valid `(a,e)` pair: elliptic when `a > 0` and `0 <= e < 1`; hyperbolic when `a < 0` and `e > 1`.
- Keep `kind` as content/rendering classification only. It never selects dynamics.
- Pin unique integer Horizons records `90000030` for 1P and `90000702` for 67P. This preserves the existing integer `horizonsId` schema and makes the J2026 bake reproducible.
- Validate every returned element pair before publishing either catalog file.

## Consequences

- Both v1 comets use the existing elliptic rail path correctly.
- Future hyperbolic objects work without a catalog-kind exception or schema change.
- Updating to a newer comet orbit solution is an explicit, reviewable definition/data change rather than an implicit closest-apparition lookup.
- The catalog schema remains version 1 because unique integer Horizons record ids cover every selected target.

## Alternatives considered

- **Treat every comet as hyperbolic.** Rejected because it contradicts the committed objects' real osculating elements.
- **Use `closest_apparition=True`.** Rejected because upstream record selection is not a stable build input.
- **Change `horizonsId` to string designations.** Rejected because it adds a schema migration while reintroducing ambiguity that numeric record ids already solve.
