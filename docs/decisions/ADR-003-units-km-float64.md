# ADR-003: Units km/km·s⁻¹/s with GM in km³/s²; all physics in float64

**Status:** accepted (2026-07-15)

## Decision

Physics uses kilometers, km/s, seconds, GM (μ) in km³/s², float64 throughout, in a single heliocentric ecliptic-J2000 frame, epoch 2026-01-01 TDB. GPU-side float32 exists only past the camera-relative boundary in `render/spaceScene.ts` (1 scene unit = 1 km).

## Why

- km-based units are JPL Horizons' native output — the bake pipeline has zero unit conversions, killing a whole class of bugs.
- float64 resolution at Neptune distance (4.5e9 km) is ~1 mm: one global frame suffices for physics; no patched/local frames needed.
- A single, explicitly documented float64→float32 boundary is auditable; scattering conversions is how precision bugs are born.

## Consequences

UI formats to m/s for Δv (HUD convention). Anyone adding SI-meters code must convert at the boundary and name variables with units (coding-standards).
