# ADR-013: Versioned body catalog and ephemeris-check schema

**Status:** accepted (2026-07-16)

## Context

The analytic rails, n-body gravity field, renderer, HUD, save initialization,
and asset pipeline all need one body catalog. T0020 introduces that shared
contract with the first Sun, planet, and Moon data baked at J2026. Changes to
`bodies.json` are ADR-gated because an implicit or drifting shape would couple
all later milestones to generator implementation details.

## Decision

Use a closed, versioned JSON document validated by
`data/bodies.schema.json` (JSON Schema draft 2020-12). The root records schema
version 1, J2026 as `JD 2461041.5 TDB`, the heliocentric ecliptic J2000 frame,
and an ordered body array.

Catalog order is semantic: a parent must occur before its children. The Sun is
the root and has null parent, elements, and SOI. Planets carry heliocentric
elements; moons carry parent-relative elements. Field names include units and
match the TypeScript orbital conversion API.

The schema reserves every v1 catalog kind (`star`, `planet`, `dwarf`, `moon`,
`asteroid`, and `comet`). Non-root bodies require a parent, elements, and a
positive SOI. Elliptic elements require `0 <= e < 1` with positive semimajor
axis; hyperbolic elements require `e > 1` with negative semimajor axis.
Parabolic `e = 1` is not representable by this element set.

Rotation period is signed, with negative values representing retrograde
rotation about the declared pole. Surface and visual objects are required but
minimal, reserving stable expansion boundaries without making runtime assets a
data-lane dependency.

Regression vectors live in a separate versioned
`ephemerides-check.json`. They are always heliocentric ecliptic J2000 states,
including for moons, at epoch, +30 days, and +365 days. Keeping checks separate
prevents runtime catalog loading from carrying test-only data.

## Consequences

- Runtime consumers can validate one explicit contract and iterate bodies in
  parent-safe order.
- Future schema changes require a version increment, migration consideration,
  and another ADR.
- Full catalog expansion adds rows without changing the schema.
- Baked regression data can change when JPL solutions improve without changing
  runtime catalog semantics.

## Alternatives considered

- **Body-id keyed object.** Rejected because JSON object order would become an
  undocumented dependency for resolving parent chains.
- **Embed check vectors in each body.** Rejected because test-only data would
  inflate and complicate the runtime catalog.
- **Allow arbitrary extension properties.** Rejected because misspellings and
  producer/consumer drift would pass validation silently.
