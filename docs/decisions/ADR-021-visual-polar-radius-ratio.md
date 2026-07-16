# ADR-021: Catalogued visual polar-radius ratio

**Status:** proposed (2026-07-16)

## Context

Planet builders must be parameterized from `data/bodies.json`, and the modeling
contract requires equatorial radius 1 with the true polar/equatorial ratio.
Catalog schema v1 exposes only mean physical radius. Deriving flattening from a
mean radius is impossible, while hardcoding it in Blender scripts would create a
second source of truth. Any catalog schema change is ADR-gated by ADR-013.

## Decision

Version 2 of the body catalog adds required `visual.polarRadiusRatio`, a finite
number greater than zero and at most one. It is the visual polar radius divided
by visual equatorial radius. Bodies intentionally rendered as spheres use 1.
Oblate planets use published equatorial and polar radii as their builders are
introduced. Earth starts with the NASA Planetary Fact Sheet radii
`6356.8 / 6378.1 = 0.996660447469`.

This field affects authored/rendered shape only. `meanRadiusKm` retains its
physics/navigation meaning and no orbital formula changes. The ephemeris baker
owns the value so regeneration cannot erase it.

## Consequences

- Blender and renderer consumers can share one explicit shape parameter.
- Catalog schema/version, generator, committed catalog, and validation tests
  change together.
- Adding a body requires an intentional shape ratio; `1` is explicit rather
  than an implicit fallback.
- Future triaxial small-body axes remain out of scope and require a separate
  representation rather than overloading this scalar.
