# T0097 Interactive System Map Design

## Goal

Deliver the v1 system map as a preallocated second three.js scene that consumes
the live immutable `SimSnapshot`, shares navigation target and camera focus with
the space view, and never pauses, replaces, or mutates simulation state merely
because the player opens or closes the map.

## Scope

The map provides:

- an accessible `M`/button toggle between space and map views;
- a top-down-capable free orbit camera with drag and wheel controls;
- one fixed-pixel icon for every catalog body;
- catalog orbit lines anchored to each body's live parent position;
- the current predicted trajectory and its SOI/approach/impact markers;
- accessible body selection that updates both navigation target and the focus
  used by the map and space cameras;
- a deterministic return to the existing space view;
- compact/reduced-motion behavior and real-browser evidence at inner- and
  outer-system scales.

The task does not add a new simulation phase, change `SimSnapshot`, change
`Commands`, alter physics, add catalog fields, or create a second renderer.

## Chosen architecture

### View orchestration

`SystemMapController` is a pure game-layer controller for `space | system-map`
mode and one validated focus body id. It invokes setup-owned callbacks when the
mode or focus changes. A UI signal adapter exposes those values to Preact, while
`main.ts` reads the controller directly in the frame loop. Opening or closing
the map never invokes a simulation command. Selecting a body deliberately calls
the existing `Commands.setTarget(bodyId)` and focuses both cameras.

The map is a view inside `SpacePhase`, not a new scene-manager phase. Therefore
saves remain `phase: "space"`, the integrator continues stepping, time warp
continues, the predictor continues, and no protected interface changes.

### Input and accessibility

The existing `CameraInputController` gains a setup-time `enabled` flag and an
allocation-free `setEnabled()` method. Space and map camera controllers are
constructed once and keep one fixed listener set; handlers return immediately
when disabled. Repeated toggles only flip booleans.

The always-mounted system-map UI owns one keyboard effect: `M` toggles and
`Escape` exits. The panel has an explicit open/close button, a labeled body
select, focus/target status, and predicted-event text. Body selection is fully
keyboard operable and uses normal pointer interaction. Reduced-motion CSS
removes transitions. Compact layouts scroll inside the panel without clipping
controls.

### Separate render scene

`SystemMapScene` owns a second `CameraRelativeSpaceScene`, camera controller,
and all map GPU resources. It is created during application preparation through
a dynamic import so Vite emits a dedicated map chunk, but every material,
geometry, typed buffer, and shader is created and compiled before the gameplay
frame loop starts.

The scene contains:

1. one `Points` draw for all body icons, with setup-time color/size attributes
   and a mutable selection attribute;
2. one `LineSegments` draw for every catalog orbit, with setup-time relative
   orbit samples and a preallocated absolute float64 buffer anchored to each
   body's live parent position;
3. one map-owned `TrajectoryOverlay`, fed the same validated worker result as
   the space overlay;
4. a camera-relative grid/ecliptic reference folded into the orbit-line draw
   when useful, rather than another repeated resource.

Icons are intentionally fixed-pixel map symbols, as required by
`rendering-spec.md` section 7. They do not change the fidelity rules of the
space view. Orbit sampling calls the existing pure orbital-element conversion;
it does not introduce another orbital formula.

### Float64 boundary

Both scenes use `CameraRelativeSpaceScene`. That class is extended with a
generic packed-position binding suitable for the map's `LineSegments`; it still
owns the only float64-to-float32 subtraction. Map code writes absolute float64
positions into caller-owned buffers. It never subtracts or accumulates physical
positions in float32.

The initial map camera focuses the Sun from near the ecliptic north pole and
frames the planetary system. Each map camera target uses a setup-time context
radius derived from the body's real radius and parent-relative orbit size, so
focus transfers show useful orbital context without altering icon scale.

### Frame flow

The common part of every frame remains:

`input -> SimulationCore.step -> snapshot/stores -> predictor -> camera updates`

Both cameras update their existing float64 state so a focus transfer completes
deterministically even while its scene is hidden. Then exactly one view renders:

- `space`: existing visuals, lighting, conic, post pipeline, and state-vector
  widget;
- `system-map`: map orbit anchors, icons, trajectory, camera-relative buffers,
  and a direct full-canvas render with the same renderer.

No scene, listener, renderer, material, geometry, shader, or typed array is
created during toggles or frames. Map-only per-frame work is skipped while the
space view is active.

### Prediction sharing

The worker remains single-instance. A successful response is validated once and
applied to both preallocated trajectory overlays. Pending/error/replacement
paths hide both overlays. Target selection keeps using the existing invalidation
policy. The map UI consumes the existing trajectory signal store, so event text
and map markers describe the same result.

### Diagnostics and verification

One setup-owned map diagnostics object is exposed beside render telemetry for
browser tests. It contains scalar counts and the selected body's latest
camera-relative/projected state; it is mutated in place and never allocated in
the frame loop. The browser suite proves:

- one renderer/canvas/map scene/input/listener set across repeated toggles;
- simulation time advances while the map is open;
- a selected inner body and an outer body remain finite, visible, and aligned
  with their orbit/trajectory data under camera-relative rendering;
- selection is shared with the target HUD and the returning space camera;
- prediction markers appear in the map when the shared worker result arrives;
- compact/reduced-motion/keyboard flows and console cleanliness;
- no GPU resource or heap growth across repeated toggles.

## Rejected alternatives

### Reparent the existing space visuals

Rejected because the map intentionally uses scaled icons and orbit lines, while
the space scene enforces true apparent size, lighting, LOD, and post effects.
Reparenting also risks GPU/resource churn and state leakage.

### Create map resources on first open

Rejected because runtime geometry/material/shader creation violates the
performance contract and makes the first toggle nondeterministic.

### Pause or clone the simulation for the map

Rejected because the task requires the same live snapshot and no simulation
pause. A clone would also create a second source of truth.

### One renderer per scene

Rejected because GPU-context policy requires one renderer/context, and a second
renderer would duplicate memory, telemetry, and failure handling.

