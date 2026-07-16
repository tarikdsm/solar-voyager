# Full Catalog Bake Design

**Task:** T0021

**Date:** 2026-07-16

## Goal

Expand the J2026 catalog from 10 to the 43 bodies explicitly listed in `docs/game-design.md`, preserving deterministic parent-first rails inputs and independent heliocentric check vectors.

## Canonical scope and ordering

The design list contains 43 bodies: Sun; eight planets; five dwarf planets; 21 moons including Charon; six asteroids; and two comets. `BODY_DEFINITIONS` remains the ordered source of truth. Every parent precedes its children so the compiled rails evaluator can accumulate parent-relative states in one pass.

Planetary moons are grouped immediately after their parent. Pluto is a Sun child and Charon is a Pluto child. Dwarfs, asteroids, and comets otherwise use the Sun as parent.

## Horizons identity and centers

Runtime `horizonsId` remains an integer; no catalog-schema migration is needed.

- Major bodies and satellites use their unambiguous numeric Horizons/NAIF target id with `id_type=None`.
- Numbered dwarf planets and asteroids use their permanent number with `id_type="smallbody"`, preventing major-body-first resolution from selecting another target.
- Comet designations are apparition-ambiguous. The bake pins the unique Horizons record ids `90000030` for 1P/Halley and `90000702` for 67P/Churyumov–Gerasimenko. These are queried with `id_type=None`.
- Element centers are derived from topology: `500@10` for Sun children and `500@<parent horizons id>` for every moon. Check vectors remain heliocentric (`500@10`) for all non-Sun bodies.

This follows the Astroquery Horizons contract: `id_type=None` accepts unique record ids, while `smallbody` restricts resolution to asteroid/comet records. Names and ambiguous designations are never used by the committed bake.

## Physical metadata

`BODY_DEFINITIONS` versions setup-time physical/visual metadata; orbital elements and check vectors remain query-derived. Sources are:

- JPL planetary physical and astrodynamic parameters for planets and dwarfs;
- JPL planetary satellite physical parameters for GM and mean radius;
- JPL Small-Body Database physical parameters for dwarf/asteroid/comet diameter, GM, rotation, and albedo where available;
- published mass/density estimates referenced by those JPL tables when an SBDB GM is absent.

Unknown pole orientations do not block the physics catalog: axial tilt may use `0` as the neutral visual placeholder, while every gravitational, radius, rotation, albedo, and seed field remains finite and schema-valid. Procedural seeds are stable explicit integers, not hash-order products.

## Eccentricity branches

Body kind does not select the Kepler branch. The signs returned by Horizons must satisfy one of the schema branches:

- elliptic: `a > 0` and `0 <= e < 1`;
- hyperbolic: `a < 0` and `e > 1`.

The pinned J2026 1P and 67P solutions are both elliptic (`e≈0.968` and `e≈0.650`). The physics spec wording is corrected from “Hyperbolic (comets)” to “Hyperbolic objects”; ADR-018 records that classification and dynamics are independent.

## Verification and generated-data effects

Offline tests lock the exact 43 ids, topology, query ids/types/centers, complete check-vector coverage, and branch validation. A real full bake produces `data/bodies.json` and `data/ephemerides-check.json`; schema tests verify the committed output.

Adding gravitational bodies deliberately moves the T0016 full-field golden trajectories. After the catalog is committed, regenerate all three through the guarded command and commit their JSON changes separately with `golden:`. T0023 will independently calibrate full-catalog rails accuracy later.

## Alternatives considered

- **Change `horizonsId` to string.** Rejected because unique numeric record ids exist for every selected target; a schema migration would add no runtime capability.
- **Query comet designations with closest-apparition selection.** Rejected because the selected record could change upstream and make the bake non-reproducible.
- **Treat all comets as hyperbolic.** Rejected because both v1 comets are bound elliptic objects at J2026.
- **Store moons heliocentrically.** Rejected because it violates the rails hierarchy and loses the intended parent-relative stability.
