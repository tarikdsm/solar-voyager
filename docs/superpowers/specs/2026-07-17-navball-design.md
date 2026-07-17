# T0055 Navball Design

## Goal

Add a sober bottom-center attitude instrument that makes the dominant-body
orbital frame readable during burns without changing the simulation contract.

## Chosen design

Use the data already present in `SimSnapshot`: dominant body index, body and ship
position/velocity, ship attitude quaternion, proper acceleration, attitude mode,
and throttle. No `SimSnapshot` or `Commands` change is required, so no ADR is
needed.

A pure UI projection writer computes the axes specified by physics-spec §3.0.1:

- prograde/retrograde: `±normalize(v_ship - v_body)`;
- radial out/in: `±normalize(r_ship - r_body)`;
- normal/antinormal: `±normalize(r_rel × v_rel)`.

The attitude quaternion maps ship-local vectors to inertial space. Its transpose
maps the inertial orbital axes back into the ship frame. Local `+X` is the nose
and instrument center, local `+Y` is screen-right, and local `+Z` is screen-up.
The front hemisphere uses the orthographic coordinates `(localY, -localZ)`;
back-hemisphere markers are hidden. The proper-acceleration vector is projected
by the same path for the thrust cue.

The writer owns no scratch allocation. It fills one setup-time `Float64Array`
whose stable slots hold marker coordinates/visibility plus horizon and thrust
values. Invalid body indices and degenerate directions clear visibility while
keeping every output finite.

## Visual structure

The instrument is one contained HUD panel with a static SVG:

- sky/ground hemispheres and an exact transformed great-circle horizon outline;
- six paired orbital markers with conventional distinct shapes and an English
  legend;
- a green thrust-vector reticle driven by proper acceleration;
- dominant-body and attitude-mode labels.

Static SVG geometry mounts once. Preact signals update only `transform` and
`opacity` at the existing 10 Hz HUD cadence. CSS transitions smooth those
compositor-safe changes. The responsive stacked layout places the navball before
camera help and preserves canvas hit-testing outside panels.

## Alternatives considered

- A second Three.js/scissored viewport would add a draw call and duplicate the
  vector-widget machinery for a DOM HUD instrument.
- A 2D canvas would redraw imperatively and make allocation/paint behavior harder
  to gate.
- A 60 Hz Preact update would improve raw latency but violate the HUD sampling
  contract and add needless DOM work. The 10 Hz signal path with transform
  interpolation is sufficient for this instrument.

## Verification

- Unit fixtures model a circular equatorial LEO and assert all six marker
  directions, quaternion inversion, thrust cue, and degenerate hiding.
- Signal tests verify 10 Hz sampling and leaf-only updates.
- Chromium regression verifies marker DOM state, zero component rerenders,
  desktop/tablet/mobile collision freedom, scrollability, and camera input outside
  panels.
- A real-browser playtest inspects the initial LEO instrument and active thrust.
- Before/after scaffold benchmarks and the simulation benchmark document budget
  impact.
