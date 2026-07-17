# T0044 Camera Controls Design

## Scope

T0044 adds an allocation-free orbit camera around any catalog body, a generic
target contract that can later point at the ship, smooth target changes, and a
surface-to-system zoom range. The production controls are pointer drag to
orbit, wheel to zoom, `[`/`]` to cycle targets, and direct `E`/`J` shortcuts
for the acceptance path. A small DOM overlay identifies the current focus.

The task does not add a ship state, change `SimSnapshot`, `Commands`, the body
catalog schema, or physics formulas. A future ship target can use the same
packed-position target contract once a ship position is present in the game
state.

## Architecture

`OrbitCameraController` lives in `src/game/` and depends only on numeric data:

- caller-owned `Float64Array` positions;
- setup-time target records containing id, packed position offset, and radius;
- preallocated mutable camera position and look-direction records.

It never imports Three.js or the DOM. `createEpochWorld()` constructs it from
the fixed J2026 body order and returns it with the render world. A small
`CameraInputController` in `src/ui/` owns browser listeners and forwards
accumulated pointer/wheel/keyboard intent. `main.ts` updates the numeric
controller before the existing visual-system and camera-relative bridges.

The Three.js perspective camera remains permanently at scene origin. Each
frame, its orientation is updated with the controller's numeric look direction,
then `CameraRelativeSpaceScene` subtracts the float64 camera position before
the float32 bridge as required by `docs/rendering-spec.md` section 1.

## Orbit and Zoom

The orbit is stored as yaw and pitch around the focus, not accumulated Three.js
vectors. The unit offset is recomputed from trigonometric values into existing
numeric fields. Pitch is clamped short of the poles. Camera position is:

`camera = focus + unitOffset * distanceKm`

and look direction is `-unitOffset`. Wheel input applies exponential scaling,
which gives useful precision both near a surface and at interplanetary scale.
The lower limit is `radius + max(0.002 km, radius * 1e-6)` and the upper limit
is `1e10 km`, matching the renderer's system-wide far range.

## Focus Transfer

On a focus request, the controller snapshots the current interpolated focus,
the current distance, and the destination body's current float64 position.
Over 1.5 seconds it uses quintic smootherstep for position and logarithmic
distance interpolation. A `sin²(pi*t)` distance envelope adds up to 15% of
the target travel distance at mid-transfer. This provides solar-system context
instead of sweeping the camera through hundreds of millions of kilometres at
LEO distance. Both the interpolation and the envelope have zero endpoint
velocity, so handoff into and out of the orbit state is continuous.

The destination position is read from the caller-owned packed array on every
update, so the same implementation follows moving simulation targets. A new
focus request during a transfer starts from the current interpolated state.
The surface-safe minimum distance is itself smootherstep-interpolated between
the source and destination targets, preventing zoom input during travel from
placing the camera inside the destination or creating an arrival-frame clamp.

## Input and Accessibility

Pointer capture keeps dragging stable outside the canvas. Browser defaults are
prevented only for an active drag and canvas wheel input. Keyboard focus changes
ignore repeated keydown events. The focus label is updated only when the target
changes, outside the frame loop.

The canvas receives an accessible controls description. Input listeners are
owned by a disposable adapter so hot reload and future scene transitions do not
leak handlers.

## Performance and Verification

The frame path creates no arrays, objects, closures, strings, or Three.js
resources. All scratch values are numeric fields or setup-time records. Target
lookup and label formatting occur only on user focus events.

Unit tests cover orbit normalization, zoom limits, interrupted transfers,
Earth-to-Jupiter endpoint continuity, live target movement, and a minimum-zoom
large-coordinate stability regression. A Playwright WebGL fixture exercises a
real Earth-to-Jupiter transfer and records screen-space continuity and repeated
minimum-zoom frames. Full lint, typecheck, unit, render regression, build,
budget, and benchmark gates complete the task.
