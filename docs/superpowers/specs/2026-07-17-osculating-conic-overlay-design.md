# T0057 Osculating Conic Overlay Design

## Goal

Render an immediate analytic ellipse or hyperbola around the simulation's
dominant body while the future trajectory worker refines the propagated path.
The overlay must match the physics-spec section 6 osculating state, avoid
dominant-body flicker at sphere-of-influence boundaries, and add no frame-loop
allocations.

## Chosen approach

Use one setup-time `Line2` with storage for 256 segments. Its vertices are
body-relative kilometre offsets, while a mutable float64 anchor holds the
dominant body's heliocentric position. `CameraRelativeSpaceScene` binds that
anchor once and remains the only float64-to-float32 camera-relative boundary.
The renderer updates the existing interleaved `instanceStart`/`instanceEnd`
buffer and `instanceCount`; it never calls `LineGeometry.setPositions()` in the
frame loop.

This is preferred over a basic WebGL `Line`, which cannot guarantee the required
fat-line appearance, and over one `Line2` per body, which would create needless
geometry, materials, and scene nodes when only one conic is visible.

## Dominant-body hysteresis

The compiled rails catalog gains a setup-time `soiRadiiKm` float64 array sourced
from the existing `bodies.json` values. The osculating workspace retains the
previous dominant index. Selection still starts from the instantaneous
`mu / distance^2` maximum, then applies the physics-spec section 6 ten-percent
band:

- a child body may replace its current ancestor only after entering `0.9` of
  the child's SOI and exceeding the current gravity score by 10%;
- a parent may not reclaim dominance until the current child exits `1.1` of
  the child's SOI;
- unrelated contenders must exceed the current gravity score by 10%;
- invalid initial state falls back to the raw maximum-gravity result.

Parent relationships come from the existing compiled `parentIndices` array.
This keeps transitions deterministic and allocation-free without changing
`SimSnapshot`, `Commands`, or the `bodies.json` schema, so no interface ADR is
required.

## Analytic conic sampling

Sampling uses the snapshot's canonical osculating elements. In the perifocal
plane, each point follows `r = p / (1 + e cos(nu))`, with
`p = a(1 - e^2)`, then uses the same
`Rz(Omega) * Rx(i) * Rz(omega)` rotation as the simulation conversion.

Ellipses close over `[-pi, pi]`. Segment count is 64 below eccentricity 0.25,
128 below 0.75, and 256 otherwise. Hyperbolas use 256 open segments and stop
short of both asymptotes; a render-only radius cap prevents non-finite or
astronomically large endpoints near the asymptote. Invalid, parabolic, or
non-finite snapshots hide the line.

## Runtime integration and appearance

`createEpochWorld()` constructs the overlay before shader precompilation and
returns it with the other render systems. Each frame, after the simulation
snapshot is published and before camera-relative positions are updated,
`main.ts` passes the snapshot and drawing-buffer dimensions to the overlay.

The line is cyan, translucent, depth-tested, and depth-write disabled. Its
width is expressed in screen pixels through `LineMaterial`, so it remains
legible across camera distances. It costs one draw call only while visible and
is excluded from frustum-bound recomputation because its dynamic geometry is
already deliberately bounded and visibility-controlled.

## Error handling

Setup validates catalog array lengths and the preallocated Three.js attributes.
The hot update path does not throw for physically invalid osculating solutions;
it hides the overlay and returns. Structural corruption detected during setup
or tests remains an explicit error.

## Verification

- A two-body test compares sampled ellipse points with the existing canonical
  Cartesian element conversion.
- Hyperbola tests require finite open branches and no artificial closing
  segment.
- Hysteresis tests oscillate inputs across child SOI entry/exit boundaries and
  verify stable ownership.
- Renderer tests verify stable geometry/attribute identities, bounded
  `instanceCount`, visibility on invalid snapshots, and unchanged anchor
  storage across repeated updates.
- Full lint, typecheck, Vitest, production build, budgets, and task schema run.
- A real-browser playtest checks the visible conic, console cleanliness, and
  frame behavior after the render-path change.
